import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import crypto from 'node:crypto';
import { URL } from 'node:url';
import pdfParse from 'pdf-parse';
import config from '../config/env.js';
import sourceGroundedConfig from '../config/sourceGroundedConfig.js';
import {
  parseGoogleDriveUrl,
  buildDriveCandidateRequests,
  extractDriveConfirmToken,
  classifyDriveHtmlBlock,
  DRIVE_ERROR_MESSAGES,
} from './googleDriveSourceProvider.js';

const dnsLookup = dns.promises.lookup;

// Source-Grounded AI Question Generation — SSRF-safe outbound fetch for
// creator-supplied URLs. Nothing like this exists elsewhere in the
// codebase (every other outbound call is to a fixed, trusted provider
// like OpenAI), so this is written from scratch and kept intentionally
// free of any Mongoose/DB dependency so it is trivially unit-testable in
// isolation (see tests/secureUrlFetch.test.js).
//
// Threat model covered: non-http(s) schemes, loopback, RFC1918/RFC4193
// private ranges, link-local (incl. cloud metadata 169.254.169.254),
// multicast/reserved ranges, IPv4-mapped IPv6 addresses that alias a
// blocked IPv4 address, DNS rebinding (re-checked on every redirect hop,
// not just the first resolution), unbounded redirect chains, response
// timeouts, oversized responses, and unexpected content types.

const IPV4_BLOCKED_RANGES = [
  { base: [0, 0, 0, 0], bits: 8 }, // "this network"
  { base: [10, 0, 0, 0], bits: 8 }, // RFC1918
  { base: [100, 64, 0, 0], bits: 10 }, // CGNAT
  { base: [127, 0, 0, 0], bits: 8 }, // loopback
  { base: [169, 254, 0, 0], bits: 16 }, // link-local incl. cloud metadata (169.254.169.254)
  { base: [172, 16, 0, 0], bits: 12 }, // RFC1918
  { base: [192, 0, 0, 0], bits: 24 }, // IETF protocol assignments
  { base: [192, 0, 2, 0], bits: 24 }, // TEST-NET-1
  { base: [192, 168, 0, 0], bits: 16 }, // RFC1918
  { base: [198, 18, 0, 0], bits: 15 }, // benchmarking
  { base: [198, 51, 100, 0], bits: 24 }, // TEST-NET-2
  { base: [203, 0, 113, 0], bits: 24 }, // TEST-NET-3
  { base: [224, 0, 0, 0], bits: 4 }, // multicast
  { base: [240, 0, 0, 0], bits: 4 }, // reserved incl. broadcast
];

const ipv4ToInt = (octets) =>
  ((octets[0] << 24) | (octets[1] << 16) | (octets[2] << 8) | octets[3]) >>> 0;

const isIpv4InRange = (ipInt, { base, bits }) => {
  const baseInt = ipv4ToInt(base);
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (ipInt & mask) === (baseInt & mask);
};

const isBlockedIpv4 = (address) => {
  const octets = address.split('.').map((part) => Number(part));
  if (octets.length !== 4 || octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    // Malformed input is treated as blocked — fail closed.
    return true;
  }
  const ipInt = ipv4ToInt(octets);
  return IPV4_BLOCKED_RANGES.some((range) => isIpv4InRange(ipInt, range));
};

const isBlockedIpv6 = (address) => {
  const normalized = address.toLowerCase();
  if (normalized === '::1') return true; // loopback
  if (normalized === '::') return true; // unspecified
  // IPv4-mapped (::ffff:a.b.c.d) — unwrap and re-check the embedded IPv4.
  const mappedMatch = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mappedMatch) return isBlockedIpv4(mappedMatch[1]);
  // fe80::/10 link-local
  if (/^fe[89ab][0-9a-f]:/.test(normalized)) return true;
  // fc00::/7 unique local (incl. fd00::/8)
  if (/^f[cd][0-9a-f]{2}:/.test(normalized)) return true;
  return false;
};

// Exported for unit testing — the single source of truth for "is this IP
// address one we must never let the server connect to."
export const isBlockedIp = (address) => {
  if (typeof address !== 'string' || !address) return true;
  if (address.includes(':')) return isBlockedIpv6(address);
  return isBlockedIpv4(address);
};

class SecureUrlFetchError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'SecureUrlFetchError';
    this.code = code || 'SSRF_BLOCKED';
  }
}

// Resolves a hostname and throws if ANY resolved address is blocked —
// resolving `all: true` (not just the first result) closes the gap where
// a multi-answer DNS response's first entry is public but a later entry
// (or a later re-resolution, i.e. DNS rebinding) is private.
const resolveAndAssertPublicHost = async (hostname, dnsLookupFn = dnsLookup) => {
  let addresses;
  try {
    addresses = await dnsLookupFn(hostname, { all: true, verbatim: true });
  } catch (error) {
    throw new SecureUrlFetchError(`Could not resolve host: ${hostname}`, 'DNS_RESOLUTION_FAILED');
  }
  if (!addresses.length) {
    throw new SecureUrlFetchError(`Could not resolve host: ${hostname}`, 'DNS_RESOLUTION_FAILED');
  }
  const blocked = addresses.find(({ address }) => isBlockedIp(address));
  if (blocked) {
    throw new SecureUrlFetchError(
      `URL resolves to a disallowed address (${blocked.address}).`,
      'PRIVATE_ADDRESS_BLOCKED'
    );
  }
  // Return the first resolved address to actually connect to (both for
  // determinism and so the caller can record it for audit).
  return addresses[0].address;
};

const assertAllowedUrl = (rawUrl) => {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch (error) {
    throw new SecureUrlFetchError('Invalid URL.', 'INVALID_URL');
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new SecureUrlFetchError('Only http and https URLs are allowed.', 'PROTOCOL_NOT_ALLOWED');
  }
  if (parsed.username || parsed.password) {
    throw new SecureUrlFetchError('URLs with embedded credentials are not allowed.', 'CREDENTIALS_IN_URL');
  }
  return parsed;
};

// One request/response round trip against an already-IP-validated host.
// Enforces timeout, max response bytes, and content-type allowlist while
// streaming (aborts as soon as any limit is exceeded, never buffers past
// the cap).
const performRequest = ({
  url,
  resolvedIp,
  timeoutMs,
  maxResponseBytes,
  allowedContentTypes = sourceGroundedConfig.SSRF_ALLOWED_CONTENT_TYPES,
}) =>
  new Promise((resolve, reject) => {
    const transport = url.protocol === 'https:' ? https : http;
    const requestOptions = {
      method: 'GET',
      // Connect directly to the pre-validated IP, but keep sending the
      // original Host header — this is what actually closes the DNS
      // rebinding gap (a second lookup at connect time could return a
      // different, unvalidated address).
      host: resolvedIp,
      servername: url.protocol === 'https:' ? url.hostname : undefined,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: `${url.pathname}${url.search}`,
      headers: {
        Host: url.hostname,
        'User-Agent': 'XamigoSourceIngestion/1.0 (+source-grounded-question-generation)',
        Accept: allowedContentTypes.join(', '),
      },
      timeout: timeoutMs,
    };

    const req = transport.request(requestOptions, (res) => {
      const contentType = String(res.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
      const statusCode = res.statusCode || 0;

      if (statusCode >= 300 && statusCode < 400 && res.headers.location) {
        res.resume(); // drain, discard body
        resolve({ redirect: res.headers.location, statusCode });
        return;
      }

      if (statusCode < 200 || statusCode >= 300) {
        res.resume();
        reject(new SecureUrlFetchError(`Source URL responded with HTTP ${statusCode}.`, 'HTTP_ERROR'));
        return;
      }

      if (!allowedContentTypes.includes(contentType)) {
        res.resume();
        reject(new SecureUrlFetchError(`Unsupported content type: ${contentType || 'unknown'}.`, 'UNSUPPORTED_CONTENT_TYPE'));
        return;
      }

      const chunks = [];
      let received = 0;
      let aborted = false;

      res.on('data', (chunk) => {
        if (aborted) return;
        received += chunk.length;
        if (received > maxResponseBytes) {
          aborted = true;
          res.destroy();
          reject(new SecureUrlFetchError('Source URL response exceeded the maximum allowed size.', 'RESPONSE_TOO_LARGE'));
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => {
        if (aborted) return;
        resolve({
          body: Buffer.concat(chunks),
          contentType,
          statusCode,
          contentDisposition: String(res.headers['content-disposition'] || ''),
        });
      });
      res.on('error', (error) => {
        if (aborted) return;
        reject(error);
      });
    });

    req.on('timeout', () => {
      req.destroy(new SecureUrlFetchError('Source URL request timed out.', 'TIMEOUT'));
    });
    req.on('error', (error) => {
      if (error instanceof SecureUrlFetchError) return reject(error);
      reject(new SecureUrlFetchError(error?.message || 'Source URL request failed.', 'REQUEST_FAILED'));
    });
    req.end();
  });

// Strips scripts/styles and tags down to a plain-text approximation.
// Deliberately not a full HTML parser/DOM — this only needs to produce
// reasonable text for chunking/embedding, not faithful rendering, and
// avoids adding a new dependency for it.
const stripHtmlToText = (html) => {
  return String(html || '')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|template)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|tr|table)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
};

const extractTextFromPdfBuffer = async (buffer) => {
  const parsed = await pdfParse(buffer);
  return String(parsed?.text || '').trim();
};

// Parses a filename out of a Content-Disposition response header —
// prefers the RFC 5987 filename*= form (correctly handles non-ASCII
// names) and falls back to the plain filename= form. Used for Drive
// binary downloads (see below): Drive sets this header with the file's
// real name/extension even when it mislabels the Content-Type as
// application/octet-stream, and the real extension is what lets the
// existing parseQuestionImportFile pipeline dispatch to the correct
// PDF/DOCX/XLSX parser.
export const extractFilenameFromContentDisposition = (header) => {
  const text = String(header || '');
  const extended = text.match(/filename\*=(?:UTF-8''|utf-8'')?([^;]+)/i);
  if (extended) {
    try {
      return decodeURIComponent(extended[1].trim().replace(/^"|"$/g, ''));
    } catch {
      return extended[1].trim().replace(/^"|"$/g, '');
    }
  }
  const plain = text.match(/filename="?([^";]+)"?/i);
  return plain ? plain[1].trim() : '';
};

// Follows redirects (re-validating the resolved IP on every hop) and
// returns the raw response — no content-type-specific text extraction
// yet. Extracted as its own function so both the ordinary URL path and
// the Google Drive path (which may need to inspect an HTML response
// before deciding whether it's real content or a viewer/permission page)
// share the exact same SSRF-protected transport.
const fetchRawWithSsrfProtection = async (
  startUrl,
  { timeoutMs, maxRedirects, maxResponseBytes, dnsLookupFn, allowedContentTypes }
) => {
  let currentUrl = startUrl;
  let resolvedIp = null;
  let hopsRemaining = maxRedirects;

  for (;;) {
    resolvedIp = await resolveAndAssertPublicHost(currentUrl.hostname, dnsLookupFn);
    const result = await performRequest({ url: currentUrl, resolvedIp, timeoutMs, maxResponseBytes, allowedContentTypes });

    if (result.redirect) {
      if (hopsRemaining <= 0) {
        throw new SecureUrlFetchError('Too many redirects.', 'TOO_MANY_REDIRECTS');
      }
      hopsRemaining -= 1;
      currentUrl = assertAllowedUrl(new URL(result.redirect, currentUrl).toString());
      continue;
    }

    return { ...result, resolvedIp, finalUrl: currentUrl.toString() };
  }
};

// Converts a raw fetched response into the sanitized-text snapshot shape
// every source ingestion path returns.
const finalizeTextResult = async ({ body, contentType, statusCode, resolvedIp, finalUrl }) => {
  let text = '';
  if (contentType === 'application/pdf') {
    text = await extractTextFromPdfBuffer(body);
  } else if (contentType === 'text/html') {
    text = stripHtmlToText(body.toString('utf8'));
  } else {
    text = body.toString('utf8').trim();
  }

  const snapshotHash = crypto.createHash('sha256').update(text).digest('hex');

  return {
    text,
    resolvedIp,
    httpStatus: statusCode,
    contentType,
    snapshotHash,
    finalUrl,
    sourceProvider: 'WEB',
  };
};

// Google Drive / Workspace share links must never be fetched as ordinary
// webpages — see the doc comment at the top of
// googleDriveSourceProvider.js for the exact failure this closes. Tries
// each candidate download/export URL in order; if a candidate returns
// HTML where real content was expected, attempts the large-file
// "confirm token" retry once, and otherwise fails with a specific
// DRIVE_* error code instead of silently accepting the viewer/permission
// page as document content.
// A plain uploaded FILE's download response is frequently mislabeled by
// Drive as application/octet-stream regardless of the file's actual type
// (this is what the reported "Unsupported content type:
// application/octet-stream" failure was) — Drive's Content-Type header on
// the public uc?export=download endpoint is unreliable, unlike its
// Content-Disposition filename, which does carry the real extension. Only
// FILE-kind candidates get this widened; DOCUMENT/SPREADSHEET/PRESENTATION
// always come back as text/plain or text/csv from Google's export
// endpoints and don't need it.
const DRIVE_FILE_ALLOWED_CONTENT_TYPES = [...sourceGroundedConfig.SSRF_ALLOWED_CONTENT_TYPES, 'application/octet-stream'];

const fetchGoogleDriveSourceSafely = async (drive, fetchOpts) => {
  const candidates = buildDriveCandidateRequests({ ...drive, apiKey: config.googleDriveApiKey });
  let lastError = null;

  for (const candidate of candidates) {
    try {
      const candidateFetchOpts = {
        ...fetchOpts,
        allowedContentTypes: drive.kind === 'FILE' ? DRIVE_FILE_ALLOWED_CONTENT_TYPES : undefined,
      };
      let raw = await fetchRawWithSsrfProtection(assertAllowedUrl(candidate.url), candidateFetchOpts);

      if (raw.contentType === 'text/html' && candidate.allowConfirmRetry) {
        const confirmToken = extractDriveConfirmToken(raw.body.toString('utf8'));
        if (confirmToken) {
          const retryUrl = `${candidate.url}&confirm=${confirmToken}`;
          raw = await fetchRawWithSsrfProtection(assertAllowedUrl(retryUrl), candidateFetchOpts);
        }
      }

      if (raw.contentType === 'text/html') {
        const code = classifyDriveHtmlBlock(raw.body.toString('utf8'));
        throw new SecureUrlFetchError(DRIVE_ERROR_MESSAGES[code], code);
      }

      // Content-Type couldn't be trusted to tell us the real format —
      // hand the raw bytes + the filename/extension Drive DID report
      // accurately (via Content-Disposition) to the caller, so it can be
      // routed through the same mature PDF/DOCX/XLSX extraction pipeline
      // used for directly-uploaded files instead of being blindly
      // decoded as text (master prompt §5.7: "pass the resulting bytes/
      // text through the normal Xamigo document extraction pipeline").
      if (raw.contentType === 'application/octet-stream') {
        const filename = extractFilenameFromContentDisposition(raw.contentDisposition) || `drive-file-${drive.fileId}`;
        return {
          isBinary: true,
          buffer: raw.body,
          filename,
          resolvedIp: raw.resolvedIp,
          httpStatus: raw.statusCode,
          contentType: raw.contentType,
          finalUrl: raw.finalUrl,
          sourceProvider: 'GOOGLE_DRIVE',
        };
      }

      const finalized = await finalizeTextResult(raw);
      return { ...finalized, sourceProvider: 'GOOGLE_DRIVE' };
    } catch (error) {
      lastError = error;
      // Try the next candidate (e.g. an API-key request failing falls
      // through to the public download-page trick) rather than giving up
      // on the first failure.
    }
  }

  throw lastError instanceof SecureUrlFetchError
    ? lastError
    : new SecureUrlFetchError(DRIVE_ERROR_MESSAGES.DRIVE_FILE_NOT_DOWNLOADABLE, 'DRIVE_FILE_NOT_DOWNLOADABLE');
};

/**
 * Fetches a creator-supplied URL as a Source-Grounded context source,
 * enforcing every SSRF protection described at the top of this file, and
 * returns sanitized plain text ready for chunking. Never executes page
 * JavaScript, never re-fetches after the caller stores the result (the
 * returned text IS the immutable snapshot). Google Drive/Workspace share
 * links are detected and routed through fetchGoogleDriveSourceSafely
 * instead of being treated as an ordinary webpage.
 */
export const fetchUrlSourceSafely = async ({
  url,
  timeoutMs = sourceGroundedConfig.SSRF_FETCH_TIMEOUT_MS,
  maxRedirects = sourceGroundedConfig.SSRF_MAX_REDIRECTS,
  maxResponseBytes = sourceGroundedConfig.SSRF_MAX_RESPONSE_BYTES,
  dnsLookupFn = dnsLookup,
} = {}) => {
  const fetchOpts = { timeoutMs, maxRedirects, maxResponseBytes, dnsLookupFn };

  const drive = parseGoogleDriveUrl(url);
  if (drive) {
    return fetchGoogleDriveSourceSafely(drive, fetchOpts);
  }

  const raw = await fetchRawWithSsrfProtection(assertAllowedUrl(url), fetchOpts);
  return finalizeTextResult(raw);
};

export { SecureUrlFetchError };
