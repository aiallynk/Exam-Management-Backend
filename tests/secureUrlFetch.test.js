import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { isBlockedIp, fetchUrlSourceSafely, extractFilenameFromContentDisposition } from '../services/secureUrlFetchService.js';

// Pure, DB/network-free unit tests for the SSRF IP-blocking allowlist —
// the single source of truth every fetch (including every redirect hop)
// is checked against.

describe('isBlockedIp — IPv4', () => {
  test('blocks loopback', () => {
    assert.equal(isBlockedIp('127.0.0.1'), true);
    assert.equal(isBlockedIp('127.255.255.255'), true);
  });

  test('blocks RFC1918 private ranges', () => {
    assert.equal(isBlockedIp('10.0.0.1'), true);
    assert.equal(isBlockedIp('172.16.5.4'), true);
    assert.equal(isBlockedIp('172.31.255.255'), true);
    assert.equal(isBlockedIp('192.168.1.1'), true);
  });

  test('blocks link-local incl. the cloud metadata address', () => {
    assert.equal(isBlockedIp('169.254.169.254'), true); // AWS/GCP/Azure metadata
    assert.equal(isBlockedIp('169.254.0.1'), true);
  });

  test('blocks CGNAT, TEST-NET, benchmarking, multicast, and reserved ranges', () => {
    assert.equal(isBlockedIp('100.64.0.1'), true);
    assert.equal(isBlockedIp('192.0.2.1'), true);
    assert.equal(isBlockedIp('198.51.100.1'), true);
    assert.equal(isBlockedIp('203.0.113.1'), true);
    assert.equal(isBlockedIp('224.0.0.1'), true);
    assert.equal(isBlockedIp('255.255.255.255'), true);
  });

  test('allows ordinary public IPv4 addresses', () => {
    assert.equal(isBlockedIp('8.8.8.8'), false);
    assert.equal(isBlockedIp('1.1.1.1'), false);
    assert.equal(isBlockedIp('93.184.216.34'), false);
  });

  test('fails closed on malformed input', () => {
    assert.equal(isBlockedIp('not-an-ip'), true);
    assert.equal(isBlockedIp(''), true);
    assert.equal(isBlockedIp(null), true);
  });
});

describe('isBlockedIp — IPv6', () => {
  test('blocks loopback and unspecified', () => {
    assert.equal(isBlockedIp('::1'), true);
    assert.equal(isBlockedIp('::'), true);
  });

  test('blocks link-local and unique-local ranges', () => {
    assert.equal(isBlockedIp('fe80::1'), true);
    assert.equal(isBlockedIp('fd00::1'), true);
    assert.equal(isBlockedIp('fc00::1'), true);
  });

  test('blocks an IPv4-mapped address whose embedded IPv4 is private', () => {
    assert.equal(isBlockedIp('::ffff:169.254.169.254'), true);
    assert.equal(isBlockedIp('::ffff:10.0.0.1'), true);
  });

  test('allows an IPv4-mapped address whose embedded IPv4 is public', () => {
    assert.equal(isBlockedIp('::ffff:8.8.8.8'), false);
  });

  test('allows an ordinary public IPv6 address', () => {
    assert.equal(isBlockedIp('2606:4700:4700::1111'), false); // Cloudflare DNS
  });
});

describe('fetchUrlSourceSafely — pre-connection validation (no network required)', () => {
  test('rejects non-http(s) protocols before any DNS lookup', async () => {
    await assert.rejects(
      () => fetchUrlSourceSafely({ url: 'ftp://example.com/file.txt' }),
      /http and https/i
    );
  });

  test('rejects URLs with embedded credentials', async () => {
    await assert.rejects(
      () => fetchUrlSourceSafely({ url: 'http://user:pass@example.com/' }),
      /credentials/i
    );
  });

  test('rejects when the resolved address is private — the core SSRF guard', async () => {
    // Injected resolver simulates a hostname that resolves to the cloud
    // metadata address. No real network call happens: resolution is
    // checked and rejected before any HTTP request is issued.
    await assert.rejects(
      () =>
        fetchUrlSourceSafely({
          url: 'http://internal.example.com/',
          dnsLookupFn: async () => [{ address: '169.254.169.254', family: 4 }],
        }),
      /disallowed address/i
    );
  });

  test('rejects when ANY of multiple resolved addresses is private, not only the first', async () => {
    await assert.rejects(
      () =>
        fetchUrlSourceSafely({
          url: 'http://multi.example.com/',
          dnsLookupFn: async () => [
            { address: '8.8.8.8', family: 4 },
            { address: '10.0.0.5', family: 4 },
          ],
        }),
      /disallowed address/i
    );
  });
});

describe('extractFilenameFromContentDisposition — Google Drive binary-download filename recovery', () => {
  // Regression coverage for the reported bug: Drive's uc?export=download
  // endpoint frequently returns Content-Type: application/octet-stream
  // regardless of the file's real type, but its Content-Disposition
  // header does carry the real filename/extension — this is what lets
  // the downloaded bytes be routed through the correct PDF/DOCX/XLSX
  // parser instead of the request being rejected outright as an
  // "unsupported content type" (exactly what the user hit).

  test('extracts a plain filename= value', () => {
    assert.equal(
      extractFilenameFromContentDisposition('attachment; filename="Chapter 3 Notes.pdf"'),
      'Chapter 3 Notes.pdf'
    );
  });

  test('prefers the RFC 5987 filename*= form when both are present', () => {
    const header = "attachment; filename=\"fallback.pdf\"; filename*=UTF-8''Chapter%203%20Notes.pdf";
    assert.equal(extractFilenameFromContentDisposition(header), 'Chapter 3 Notes.pdf');
  });

  test('returns empty string when no filename is present', () => {
    assert.equal(extractFilenameFromContentDisposition('attachment'), '');
    assert.equal(extractFilenameFromContentDisposition(''), '');
    assert.equal(extractFilenameFromContentDisposition(undefined), '');
  });
});
