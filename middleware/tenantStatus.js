import Tenant from '../models/Tenant.js';

export const TENANT_INACTIVE_LOGIN_MESSAGE =
  'Your organization is currently inactive. Contact admin.';
export const TENANT_INACTIVE_ACCESS_MESSAGE = 'Tenant is inactive. Access denied.';
export const TENANT_SESSION_EXPIRED_MESSAGE = 'Session expired';

export const normalizeTenantTokenVersion = (value) => {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return parsed;
};

/**
 * Token-version compatibility rule:
 * - New tokens carry tokenVersion and must match tenant.tokenVersion exactly.
 * - Legacy tokens without tokenVersion are accepted only while tenant.tokenVersion is 0.
 */
export const isTenantTokenVersionValid = (decodedTokenVersion, tenantTokenVersion) => {
  const normalizedTenantTokenVersion = normalizeTenantTokenVersion(tenantTokenVersion);

  if (decodedTokenVersion === undefined || decodedTokenVersion === null || decodedTokenVersion === '') {
    return normalizedTenantTokenVersion === 0;
  }

  const normalizedDecodedTokenVersion = normalizeTenantTokenVersion(decodedTokenVersion);
  return normalizedDecodedTokenVersion === normalizedTenantTokenVersion;
};

const normalizeTenantStatus = (value) => String(value || '').trim().toUpperCase();

const buildTenantInactivePayload = (message = TENANT_INACTIVE_ACCESS_MESSAGE) => ({
  success: false,
  error: message,
  message,
});

export const validateTenantAccessState = async ({
  tenantId,
  decodedTokenVersion,
  select = 'status tokenVersion subscription',
  inactiveMessage = TENANT_INACTIVE_ACCESS_MESSAGE,
  skipTokenVersionCheck = false,
} = {}) => {
  if (!tenantId) {
    return {
      allowed: true,
      tenant: null,
      statusCode: null,
      payload: null,
    };
  }

  const tenant = await Tenant.findById(tenantId).select(select);
  if (!tenant) {
    return {
      allowed: false,
      tenant: null,
      statusCode: 403,
      payload: buildTenantInactivePayload(inactiveMessage),
    };
  }

  const normalizedStatus = normalizeTenantStatus(tenant.status);
  if (normalizedStatus !== 'ACTIVE') {
    return {
      allowed: false,
      tenant,
      statusCode: 403,
      payload: buildTenantInactivePayload(inactiveMessage),
    };
  }

  if (!skipTokenVersionCheck) {
    const isVersionValid = isTenantTokenVersionValid(
      decodedTokenVersion,
      tenant.tokenVersion
    );
    if (!isVersionValid) {
      return {
        allowed: false,
        tenant,
        statusCode: 401,
        payload: {
          success: false,
          error: TENANT_SESSION_EXPIRED_MESSAGE,
          message: TENANT_SESSION_EXPIRED_MESSAGE,
          code: 'SESSION_EXPIRED',
        },
      };
    }
  }

  return {
    allowed: true,
    tenant,
    statusCode: null,
    payload: null,
  };
};

/**
 * Optional route middleware variant.
 * Most protected routes are already covered through requireAuth global checks.
 */
export const checkTenantActive = async (req, res, next) => {
  try {
    if (!req.user || req.user.role === 'SUPER_ADMIN') {
      return next();
    }

    const result = await validateTenantAccessState({
      tenantId: req.user.tenantId,
      decodedTokenVersion: req.user.tokenVersion,
      select: 'status tokenVersion',
    });

    if (!result.allowed) {
      return res.status(result.statusCode).json(result.payload);
    }

    return next();
  } catch (error) {
    return next(error);
  }
};
