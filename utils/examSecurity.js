import net from 'node:net';
import { isPlanFeatureEnabled } from '../config/planLimits.js';

const normalizeString = (value) => {
  if (value === undefined || value === null) return '';
  return String(value).trim();
};

export const normalizeIpAddress = (value) => {
  const raw = normalizeString(value);
  if (!raw) return '';

  const firstHop = raw.split(',')[0].trim();
  if (!firstHop) return '';

  const withoutIpv6Wrapper = firstHop.replace(/^\[|\]$/g, '');
  let normalized = withoutIpv6Wrapper;

  if (normalized.startsWith('::ffff:')) {
    normalized = normalized.slice(7);
  }

  if (normalized.includes('.') && normalized.includes(':')) {
    const [host] = normalized.split(':');
    if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) {
      normalized = host;
    }
  }

  return normalized.toLowerCase();
};

const isValidIpAddress = (value) => net.isIP(normalizeIpAddress(value)) !== 0;

export const getRequestIpAddress = (req) => {
  const forwardedFor = req?.headers?.['x-forwarded-for'];
  const forwardedValue = Array.isArray(forwardedFor) ? forwardedFor[0] : forwardedFor;
  const forwardedIp = String(forwardedValue || '')
    .split(',')[0]
    .trim();

  return (
    forwardedIp ||
    req?.ip ||
    req?.connection?.remoteAddress ||
    req?.socket?.remoteAddress ||
    ''
  );
};

const normalizeCountryCode = (value) =>
  normalizeString(value)
    .toUpperCase()
    .replace(/[^A-Z]/g, '')
    .slice(0, 2);

const normalizeRegionCode = (value) =>
  normalizeString(value)
    .toUpperCase()
    .replace(/[^A-Z0-9_-]/g, '');

const parseList = (value) => {
  if (Array.isArray(value)) {
    return value;
  }
  if (typeof value === 'string') {
    return value.split(/[\n,;|]+/g);
  }
  return [];
};

const sanitizeIpWhitelist = (value) =>
  parseList(value)
    .map((entry) => normalizeIpAddress(entry))
    .filter((entry, index, entries) => isValidIpAddress(entry) && entries.indexOf(entry) === index);

const sanitizeGeoCodeList = (value, normalizer) =>
  parseList(value)
    .map((entry) => normalizer(entry))
    .filter((entry, index, entries) => entry && entries.indexOf(entry) === index);

const asBoolean = (value, fallback = false) => {
  if (value === undefined || value === null) return fallback;
  if (typeof value === 'boolean') return value;
  const normalized = normalizeString(value).toLowerCase();
  if (['true', '1', 'yes', 'y', 'on'].includes(normalized)) return true;
  if (['false', '0', 'no', 'n', 'off'].includes(normalized)) return false;
  return fallback;
};

export const sanitizeExamAccessControlPayload = (payload = {}, fallback = null) => {
  const source = payload && typeof payload === 'object' ? payload : {};
  const base = fallback && typeof fallback === 'object' ? fallback : {};

  const fallbackGeo = base.geoRestrictions && typeof base.geoRestrictions === 'object'
    ? base.geoRestrictions
    : {};
  const fallbackSecureBrowser = base.secureBrowser && typeof base.secureBrowser === 'object'
    ? base.secureBrowser
    : {};

  const geoSource = source.geoRestrictions && typeof source.geoRestrictions === 'object'
    ? source.geoRestrictions
    : {};
  const secureBrowserSource = source.secureBrowser && typeof source.secureBrowser === 'object'
    ? source.secureBrowser
    : {};

  return {
    ipWhitelist: sanitizeIpWhitelist(
      source.ipWhitelist !== undefined ? source.ipWhitelist : base.ipWhitelist
    ),
    geoRestrictions: {
      enabled: asBoolean(
        geoSource.enabled !== undefined ? geoSource.enabled : fallbackGeo.enabled,
        false
      ),
      allowedCountries: sanitizeGeoCodeList(
        geoSource.allowedCountries !== undefined
          ? geoSource.allowedCountries
          : fallbackGeo.allowedCountries,
        normalizeCountryCode
      ),
      allowedRegions: sanitizeGeoCodeList(
        geoSource.allowedRegions !== undefined
          ? geoSource.allowedRegions
          : fallbackGeo.allowedRegions,
        normalizeRegionCode
      ),
      allowUnknownLocation: asBoolean(
        geoSource.allowUnknownLocation !== undefined
          ? geoSource.allowUnknownLocation
          : fallbackGeo.allowUnknownLocation,
        true
      ),
    },
    secureBrowser: {
      enabled: asBoolean(
        secureBrowserSource.enabled !== undefined
          ? secureBrowserSource.enabled
          : fallbackSecureBrowser.enabled,
        true
      ),
      requireFullscreen: asBoolean(
        secureBrowserSource.requireFullscreen !== undefined
          ? secureBrowserSource.requireFullscreen
          : fallbackSecureBrowser.requireFullscreen,
        true
      ),
      blockClipboard: asBoolean(
        secureBrowserSource.blockClipboard !== undefined
          ? secureBrowserSource.blockClipboard
          : fallbackSecureBrowser.blockClipboard,
        true
      ),
      blockRightClick: asBoolean(
        secureBrowserSource.blockRightClick !== undefined
          ? secureBrowserSource.blockRightClick
          : fallbackSecureBrowser.blockRightClick,
        true
      ),
      blockKeyboardShortcuts: asBoolean(
        secureBrowserSource.blockKeyboardShortcuts !== undefined
          ? secureBrowserSource.blockKeyboardShortcuts
          : fallbackSecureBrowser.blockKeyboardShortcuts,
        true
      ),
      blockTabSwitch: asBoolean(
        secureBrowserSource.blockTabSwitch !== undefined
          ? secureBrowserSource.blockTabSwitch
          : fallbackSecureBrowser.blockTabSwitch,
        true
      ),
    },
  };
};

export const resolveRequestGeoContext = (req) => {
  const headers = req?.headers || {};
  const country = normalizeCountryCode(
    headers['x-country-code'] ||
    headers['x-vercel-ip-country'] ||
    headers['cf-ipcountry'] ||
    headers['x-appengine-country'] ||
    headers['x-geo-country'] ||
    headers['x-country']
  );
  const region = normalizeRegionCode(
    headers['x-vercel-ip-country-region'] ||
    headers['cf-region-code'] ||
    headers['x-geo-region'] ||
    headers['x-region']
  );

  return { country, region };
};

export const enforceExamAccessControl = ({
  exam,
  req,
  planType = null,
} = {}) => {
  const accessControl = sanitizeExamAccessControlPayload(exam?.accessControl || {});
  const currentIpRaw = getRequestIpAddress(req);
  const currentIp = normalizeIpAddress(currentIpRaw);
  const geo = resolveRequestGeoContext(req);

  const ipWhitelistEnabled = isPlanFeatureEnabled(planType, 'ipWhitelist');
  if (ipWhitelistEnabled && accessControl.ipWhitelist.length > 0) {
    if (!currentIp || !accessControl.ipWhitelist.includes(currentIp)) {
      return {
        allowed: false,
        error: 'Access denied: this exam is restricted to whitelisted IP addresses.',
        reason: 'IP_WHITELIST_RESTRICTED',
        context: {
          currentIp: currentIpRaw || currentIp || '',
        },
      };
    }
  }

  const geoRestrictionEnabled = isPlanFeatureEnabled(planType, 'geoLocationRestriction');
  const geoRestrictions = accessControl.geoRestrictions || {};
  if (geoRestrictionEnabled && geoRestrictions.enabled) {
    if (geoRestrictions.allowedCountries.length > 0) {
      if (!geo.country) {
        if (!geoRestrictions.allowUnknownLocation) {
          return {
            allowed: false,
            error: 'Access denied: location could not be validated for this exam.',
            reason: 'GEO_COUNTRY_UNKNOWN',
            context: geo,
          };
        }
      } else if (!geoRestrictions.allowedCountries.includes(geo.country)) {
        return {
          allowed: false,
          error: 'Access denied: this exam is not available in your country.',
          reason: 'GEO_COUNTRY_RESTRICTED',
          context: geo,
        };
      }
    }

    if (geoRestrictions.allowedRegions.length > 0) {
      if (!geo.region) {
        if (!geoRestrictions.allowUnknownLocation) {
          return {
            allowed: false,
            error: 'Access denied: region could not be validated for this exam.',
            reason: 'GEO_REGION_UNKNOWN',
            context: geo,
          };
        }
      } else if (!geoRestrictions.allowedRegions.includes(geo.region)) {
        return {
          allowed: false,
          error: 'Access denied: this exam is not available in your region.',
          reason: 'GEO_REGION_RESTRICTED',
          context: geo,
        };
      }
    }
  }

  return {
    allowed: true,
    context: {
      currentIp: currentIpRaw || currentIp || '',
      ...geo,
      accessControl,
    },
  };
};

