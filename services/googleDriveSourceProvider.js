// Source-Grounded AI Question Generation — Google Drive/Workspace URL
// recognition and download/export target resolution.
//
// Root-cause fix: secureUrlFetchService previously treated every URL,
// including Drive share links, as an ordinary webpage. A Drive share link
// (drive.google.com/file/d/{id}/view) returns an HTML viewer/sign-in page
// when fetched like a normal page — that HTML is non-empty, so it silently
// passed the "did we get any text" check, got chunked/embedded as if it
// were the real document, and was marked READY. At generation time those
// garbage chunks never scored above the retrieval similarity threshold,
// so retrieval came back empty and the generic "insufficient source
// information" error surfaced — even though the creator's file genuinely
// had usable content. This module makes Drive links first-class: it
// recognizes them, resolves the actual download/export endpoint, and
// distinguishes "we got the real file" from "we got a viewer/permission
// page" so ingestion can fail with a specific, actionable reason instead
// of silently ingesting garbage.
//
// No OAuth/service-account flow is implemented (that would require a
// credential the operator must explicitly provision and consent-grant per
// file, out of scope for a server-side background ingestion job). Instead:
//   1. If GOOGLE_DRIVE_API_KEY is configured, prefer the official Drive v3
//      `files.get?alt=media` endpoint — this works for any file whose
//      sharing permission includes "Anyone with the link" without any
//      OAuth/user consent, per Drive API's documented public-key access
//      model, and is far more reliable than (2) for large/binary files.
//   2. Otherwise fall back to the long-standing public download pattern
//      (`drive.google.com/uc?export=download`) and the Workspace
//      `.../export?format=...` endpoints, which also only work for
//      publicly-shared content. Both paths are fetched through the exact
//      same SSRF-safe transport as every other URL (see
//      secureUrlFetchService.js) — nothing here bypasses IP/redirect
//      validation.
//
// Never hard-codes a credential; GOOGLE_DRIVE_API_KEY is optional and read
// only from config/env.js.

const DRIVE_HOSTS = new Set(['drive.google.com', 'docs.google.com']);

const DRIVE_ID_RE = /^[-\w]{10,}$/;

export const isGoogleDriveUrl = (rawUrl) => {
  try {
    const parsed = new URL(rawUrl);
    return DRIVE_HOSTS.has(parsed.hostname);
  } catch {
    return false;
  }
};

/**
 * Recognizes the common Google Drive / Workspace shared-link shapes and
 * extracts the file/document identifier. Returns null for anything not
 * recognized (e.g. a Drive folder link, which this feature does not
 * support — a folder is not a single ingestible document).
 */
export const parseGoogleDriveUrl = (rawUrl) => {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return null;
  }
  if (!DRIVE_HOSTS.has(parsed.hostname)) return null;

  const resourceKey = parsed.searchParams.get('resourcekey') || parsed.searchParams.get('resourceKey') || '';

  // drive.google.com/file/d/{FILE_ID}/view
  let match = parsed.pathname.match(/^\/file\/d\/([-\w]+)/);
  if (match && DRIVE_ID_RE.test(match[1])) {
    return { kind: 'FILE', fileId: match[1], resourceKey };
  }

  // drive.google.com/open?id={FILE_ID}  and  drive.google.com/uc?id={FILE_ID}
  if (parsed.pathname === '/open' || parsed.pathname === '/uc') {
    const id = parsed.searchParams.get('id');
    if (id && DRIVE_ID_RE.test(id)) return { kind: 'FILE', fileId: id, resourceKey };
  }

  // docs.google.com/document|spreadsheets|presentation/d/{FILE_ID}/...
  match = parsed.pathname.match(/^\/(document|spreadsheets|presentation)\/d\/([-\w]+)/);
  if (match && DRIVE_ID_RE.test(match[2])) {
    const kindByPath = {
      document: 'DOCUMENT',
      spreadsheets: 'SPREADSHEET',
      presentation: 'PRESENTATION',
    };
    return { kind: kindByPath[match[1]], fileId: match[2], resourceKey };
  }

  return null;
};

/**
 * Ordered list of candidate request URLs to try for a recognized Drive
 * source, most-reliable first. For a plain uploaded FILE, the Drive API
 * key path (if configured) is tried before the public download-page
 * trick. Workspace-native documents always use the export endpoint (no
 * API key needed or applicable there).
 */
export const buildDriveCandidateRequests = ({ kind, fileId, resourceKey, apiKey }) => {
  const resourceKeyQuery = resourceKey ? `&resourcekey=${encodeURIComponent(resourceKey)}` : '';

  if (kind === 'DOCUMENT') {
    return [{ url: `https://docs.google.com/document/d/${fileId}/export?format=txt${resourceKeyQuery}` }];
  }
  if (kind === 'SPREADSHEET') {
    return [{ url: `https://docs.google.com/spreadsheets/d/${fileId}/export?format=csv${resourceKeyQuery}` }];
  }
  if (kind === 'PRESENTATION') {
    return [{ url: `https://docs.google.com/presentation/d/${fileId}/export/txt${resourceKeyQuery}` }];
  }

  // kind === 'FILE'
  const candidates = [];
  if (apiKey) {
    candidates.push({
      url: `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media&key=${encodeURIComponent(apiKey)}`,
      allowConfirmRetry: false,
    });
  }
  candidates.push({
    url: `https://drive.google.com/uc?export=download&id=${fileId}${resourceKeyQuery}`,
    allowConfirmRetry: true,
  });
  return candidates;
};

// Google serves an HTML "can't scan this file for viruses" interstitial
// for large public files, containing a confirm token that must be
// resubmitted as a query param to actually download the bytes. This is a
// long-standing, widely-documented pattern for the public uc?export=
// download endpoint (not present when a Drive API key is used).
export const extractDriveConfirmToken = (html) => {
  const match = String(html || '').match(/confirm=([0-9A-Za-z_-]+)/);
  return match ? match[1] : null;
};

// Heuristic classification of an unexpected HTML response from a Drive
// download/export URL. Best-effort pattern matching against Google's
// publicly-visible page structure (no OAuth session available to inspect
// authoritatively) — documented as such rather than presented as exact.
export const classifyDriveHtmlBlock = (html) => {
  const text = String(html || '').toLowerCase();
  if (/sign in|you need access|request access|accounts\.google\.com/.test(text)) {
    return 'DRIVE_PERMISSION_REQUIRED';
  }
  return 'DRIVE_FILE_NOT_DOWNLOADABLE';
};

export const DRIVE_ERROR_MESSAGES = Object.freeze({
  DRIVE_PERMISSION_REQUIRED:
    'This Google Drive file is not publicly accessible. Set sharing to "Anyone with the link" (Viewer) and try again.',
  DRIVE_FILE_NOT_DOWNLOADABLE:
    'This Google Drive file could not be downloaded. It may not support direct export, the link may be invalid, or the file may have been removed.',
  DRIVE_EXPORT_FAILED:
    'This Google Drive document could not be exported to text. Try downloading it and uploading it as a file instead.',
});
