import express from 'express';
import jwt from 'jsonwebtoken';
import config from '../config/env.js';
import User from '../models/User.js';
import Tenant from '../models/Tenant.js';
import { requireAuth } from '../middleware/auth.js';
import { body, validationResult } from 'express-validator';
import { addToBlacklist, isBlacklisted } from '../utils/tokenBlacklist.js';
import { validatePasswordStrength as validatePassword } from '../utils/passwordValidator.js';
import { auditLogin, auditLogout } from '../middleware/audit.js';
import { resolveTenantSnapshot } from '../utils/tenantResolver.js';
import {
  isFreePlan,
  isTrialRestrictedPlan,
  resolveSubscriptionStatus,
  SUBSCRIPTION_STATUSES,
  SUBSCRIPTION_STATUS_MESSAGES,
} from '../config/planLimits.js';

const router = express.Router();

const toTenantIdString = (tenantRef) => {
  if (!tenantRef) return null;
  if (typeof tenantRef === 'object' && tenantRef._id) return String(tenantRef._id);
  return String(tenantRef);
};

const normalizePlanType = (value) => String(value || '').trim().toLowerCase();
const escapeRegex = (value) => String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const buildTenantCodeCandidate = (seed, attemptIndex = 0) => {
  const normalizedSeed = String(seed || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, 5) || 'DEMO';

  const timestampSuffix = Date.now().toString().slice(-5);
  const randomSuffix = Math.floor(Math.random() * 900 + 100).toString();
  const retrySuffix = attemptIndex > 0 ? String(attemptIndex).padStart(2, '0') : '';

  return `TRI${normalizedSeed}${timestampSuffix}${randomSuffix}${retrySuffix}`;
};

const ensureTrialTenant = async ({ user }) => {
  if (!user?._id) return null;

  const existingTenantId = toTenantIdString(user.tenantId);
  if (existingTenantId) {
    return existingTenantId;
  }

  const baseSeed = user.email?.split('@')?.[0] || user.name || 'demo';
  let lastError = null;

  for (let attempt = 0; attempt < 6; attempt += 1) {
    const code = buildTenantCodeCandidate(baseSeed, attempt);
    try {
      const tenant = await Tenant.create({
        name: `${user.name || 'Demo'} Workspace`,
        code,
        type: 'INSTITUTE',
        contactEmail: user.email,
        status: 'ACTIVE',
        createdBy: user._id,
        metadata: {
          source: 'self_signup',
          signupPlanType: user.planType,
        },
      });

        user.tenantId = tenant._id;
        await user.save();

        try {
          const { createRoleNotification, createUserNotification } = await import('../services/notificationService.js');
          await createRoleNotification({
            title: 'Tenant Created',
            message: `Tenant "${tenant.name}" (${tenant.code}) was created via self-signup by ${user.name || user.email}.`,
            type: 'tenant_created',
            roles: ['SUPER_ADMIN'],
            tenantId: tenant._id,
            createdBy: user._id,
            metadata: {
              tenantId: tenant._id,
              tenantName: tenant.name,
              tenantCode: tenant.code,
              source: 'self_signup',
            },
          });
          await createUserNotification({
            title: 'Workspace Ready',
            message: `Your tenant workspace "${tenant.name}" is ready. You can start creating exams now.`,
            type: 'tenant_created',
            roles: [user.role],
            tenantId: tenant._id,
            userId: user._id,
            createdBy: user._id,
            metadata: {
              tenantId: tenant._id,
              tenantName: tenant.name,
            },
          });
        } catch (notifyError) {
          console.error('[NOTIFICATIONS] Failed to log self-signup tenant creation:', notifyError?.message || notifyError);
        }

        return String(tenant._id);
    } catch (error) {
      lastError = error;
      const isDuplicateCodeError = error?.code === 11000;
      if (!isDuplicateCodeError) {
        throw error;
      }
    }
  }

  throw lastError || new Error('Unable to create tenant for free trial signup');
};

const ensureTrialAdminRole = async (user) => {
  if (!user?._id || !user?.tenantId) return user;
  if (user.role !== 'EXAM_CREATOR') return user;
  if (!isTrialRestrictedPlan(user.planType) && !isFreePlan(user.planType)) return user;

  const tenant = await Tenant.findById(user.tenantId).select('_id createdBy metadata');
  if (!tenant) return user;

  const createdByMatchesUser =
    tenant.createdBy && String(tenant.createdBy) === String(user._id);
  const signupSource = String(tenant.metadata?.source || '').toLowerCase();
  const isSelfSignupOwner = createdByMatchesUser && signupSource === 'self_signup';

  if (!isSelfSignupOwner) return user;

  user.role = 'TENANT_ADMIN';
  await user.save();
  return user;
};

const verifyPasswordSafely = async (user, candidatePassword) => {
  const storedPassword = typeof user.password === 'string' ? user.password : '';
  const candidate = String(candidatePassword ?? '');

  try {
    const isValid = await user.comparePassword(candidatePassword);
    if (isValid) {
      return true;
    }
  } catch (error) {
    // Continue with legacy fallback below.
    if (process.env.NODE_ENV === 'development') {
      console.warn('[AUTH][LOGIN] comparePassword fallback path triggered:', error?.message || error);
    }
  }

  // Backward compatibility for legacy users that may have stored plaintext passwords.
  if (storedPassword && storedPassword === candidate) {
    user.password = candidate;
    await user.save();
    return true;
  }

  return false;
};

const parsePositiveInteger = (value, fallback) => {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (Number.isFinite(parsed) && parsed > 0) {
    return parsed;
  }
  return fallback;
};

const resolveRememberMeFlag = (value) =>
  value === true || String(value ?? '').trim().toLowerCase() === 'true';

const SHORT_SESSION_REFRESH_TTL_HOURS = parsePositiveInteger(
  process.env.SESSION_REFRESH_TTL_HOURS,
  24
);
const LONG_SESSION_REFRESH_TTL_DAYS = parsePositiveInteger(
  process.env.REMEMBER_ME_REFRESH_TTL_DAYS,
  parsePositiveInteger(config.refreshTtlDays, 7)
);
const BLOCK_SUSPENDED_LOGIN =
  String(process.env.BLOCK_SUSPENDED_LOGIN || 'true')
    .trim()
    .toLowerCase() !== 'false';

const setLoginAuditContext = (req, context = {}) => {
  if (!req || !context || typeof context !== 'object') return;
  const existing =
    req.auditLoginContext && typeof req.auditLoginContext === 'object'
      ? req.auditLoginContext
      : {};
  req.auditLoginContext = {
    ...existing,
    ...context,
  };
};

/**
 * Register - Create new user account
 * 
 * Simple flow:
 * - Self-signup allows EXAM_CREATOR/CANDIDATE for regular plans
 * - TENANT_ADMIN self-signup is allowed only for free_trial/demo plans
 * - SUPER_ADMIN cannot register (must be created manually)
 * - Users start without tenantId (must be assigned by SUPER_ADMIN)
 */
router.post(
  '/register',
  [
    body('name').trim().notEmpty().withMessage('Name is required'),
    body('email').isEmail().normalizeEmail().withMessage('Valid email is required'),
    body('password')
      .custom((value) => {
        try {
          validatePassword(value);
          return true;
        } catch (error) {
          throw new Error(error.message);
        }
      })
      .withMessage('Password does not meet strength requirements'),
  ],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      const { name, email, password, role, planType } = req.body;

      // Check if user exists
      const existingUser = await User.findOne({ email });
      if (existingUser) {
        return res.status(409).json({ error: 'Email already registered' });
      }

      // Simple role system:
      // - Regular plans: EXAM_CREATOR/CANDIDATE self-signup
      // - Trial/demo: TENANT_ADMIN self-signup enabled
      // - SUPER_ADMIN cannot self-register
      const selectedRole = String(role || 'CANDIDATE').toUpperCase();
      const requestedPlanType = normalizePlanType(planType);
      const allowTenantAdminSelfSignup =
        isTrialRestrictedPlan(requestedPlanType) || isFreePlan(requestedPlanType);
      const validRoles = allowTenantAdminSelfSignup
        ? ['TENANT_ADMIN', 'EXAM_CREATOR', 'CANDIDATE']
        : ['EXAM_CREATOR', 'CANDIDATE'];
      
      // Prevent SUPER_ADMIN registration
      if (selectedRole === 'SUPER_ADMIN') {
        return res.status(403).json({ error: 'Super Admin accounts cannot be created through registration' });
      }
      
      // Validate role
      if (!validRoles.includes(selectedRole)) {
        return res.status(400).json({
          error: allowTenantAdminSelfSignup
            ? 'Invalid role for registration. Must be TENANT_ADMIN, EXAM_CREATOR, or CANDIDATE'
            : 'Invalid role for registration. Must be EXAM_CREATOR or CANDIDATE',
        });
      }

      // Create user
      // Users will have tenantId set to null initially (must be assigned by Super Admin)
      const userData = {
        name,
        email,
        password,
        role: selectedRole,
      };
      if (isTrialRestrictedPlan(requestedPlanType) || isFreePlan(requestedPlanType)) {
        userData.planType = requestedPlanType;
      }

      const user = new User(userData);

      await user.save();

      // Trial/demo self-signups should receive their own tenant workspace.
      if ((isTrialRestrictedPlan(user.planType) || isFreePlan(user.planType)) && ['EXAM_CREATOR', 'TENANT_ADMIN'].includes(user.role)) {
        await ensureTrialTenant({ user });
      }

      const tenant = await resolveTenantSnapshot(user.tenantId, 'name code status type');
      const tenantId = toTenantIdString(user.tenantId);

      // Generate tokens with tenant info
      const accessToken = jwt.sign(
        {
          sub: user._id,
          email: user.email,
          name: user.name,
          role: user.role,
          tenantId: tenantId || null,
        },
        config.jwtSecret,
        { expiresIn: `${config.tokenTtlMinutes}m` }
      );

      const refreshToken = jwt.sign(
        { sub: user._id },
        config.jwtRefreshSecret,
        { expiresIn: `${config.refreshTtlDays}d` }
      );

      res.status(201).json({
        accessToken,
        refreshToken,
        user: {
          _id: user._id,
          name: user.name,
          email: user.email,
          role: user.role,
          planType: user.planType,
          examsCreated: user.examsCreated ?? 0,
          tenantId: tenant?._id || null,
          tenant: tenant || null,
        },
      });
    } catch (error) {
      next(error);
    }
  }
);

// Login
router.post(
  '/login',
  auditLogin,
  [
    body('email').isEmail().normalizeEmail(),
    body('password').notEmpty(),
    body('rememberMe').optional().isBoolean(),
  ],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      const { email, password } = req.body;
      const rememberMe = resolveRememberMeFlag(req.body?.rememberMe);
      setLoginAuditContext(req, { userEmail: email || null });

      // Find user
      let user = await User.findOne({ email });
      if (!user) {
        user = await User.findOne({
          email: { $regex: new RegExp(`^${escapeRegex(email)}$`, 'i') },
        });
      }
      if (!user) {
        // In development, provide more helpful error message
        if (process.env.NODE_ENV === 'development') {
          console.log(`⚠️  Login attempt failed: User not found - ${email}`);
          // Check if similar email exists (case-insensitive)
          const localPart =
            typeof email === 'string' && email.includes('@') ? email.split('@')[0] : '';
          if (localPart) {
            const similarUser = await User.findOne({
              email: { $regex: new RegExp(escapeRegex(localPart), 'i') },
            });
            if (similarUser) {
              console.log(`💡 Hint: Found similar user: ${similarUser.email}`);
            }
          }
        }
        return res.status(401).json({ error: 'Invalid credentials' });
      }

      setLoginAuditContext(req, {
        userId: user?._id ? String(user._id) : null,
        userName: user?.name || null,
        userEmail: user?.email || email || null,
        userRole: user?.role || null,
        tenantId: toTenantIdString(user?.tenantId),
      });

      // Check password
      let isMatch = false;
      try {
        isMatch = await verifyPasswordSafely(user, password);
      } catch (passwordError) {
        if (process.env.NODE_ENV === 'development') {
          console.error('[AUTH][LOGIN] Password verification failed:', passwordError?.message || passwordError);
        }
        return res.status(401).json({ error: 'Invalid credentials' });
      }
      if (!isMatch) {
        // In development, log password mismatch
        if (process.env.NODE_ENV === 'development') {
          console.log(`⚠️  Login attempt failed: Password mismatch for ${email}`);
        }
        return res.status(401).json({ error: 'Invalid credentials' });
      }

      // Check user status
      if (user.status && user.status !== 'ACTIVE' && user.role !== 'SUPER_ADMIN') {
        return res.status(403).json({ error: 'Account is not active' });
      }

      if (
        isTrialRestrictedPlan(user.planType) &&
        ['EXAM_CREATOR', 'TENANT_ADMIN'].includes(user.role) &&
        !user.tenantId
      ) {
        try {
          await ensureTrialTenant({ user });
        } catch (tenantError) {
          if (process.env.NODE_ENV === 'development') {
            console.error('[AUTH][LOGIN] Trial tenant bootstrap failed:', tenantError?.message || tenantError);
          }
          return res.status(503).json({
            error: 'Unable to initialize tenant workspace. Please try again.',
          });
        }
      }

      try {
        await ensureTrialAdminRole(user);
        setLoginAuditContext(req, {
          userRole: user?.role || null,
          tenantId: toTenantIdString(user?.tenantId),
        });
      } catch (roleError) {
        if (process.env.NODE_ENV === 'development') {
          console.error('[AUTH][LOGIN] Trial role sync failed:', roleError?.message || roleError);
        }
      }

      let tenant = null;
      try {
        tenant = await resolveTenantSnapshot(user.tenantId, 'name code status type');
      } catch (tenantResolveError) {
        if (process.env.NODE_ENV === 'development') {
          console.error('[AUTH][LOGIN] Tenant resolution failed:', tenantResolveError?.message || tenantResolveError);
        }
      }
      const tenantId = toTenantIdString(user.tenantId);
      let subscriptionStatus = SUBSCRIPTION_STATUSES.ACTIVE;
      let subscriptionWarning = '';

      if (tenantId && user.role !== 'SUPER_ADMIN') {
        try {
          const tenantSubscription = await Tenant.findById(tenantId).select('subscription').lean();
          const subscription = tenantSubscription?.subscription || {};
          subscriptionStatus = resolveSubscriptionStatus(subscription);

          const persistedStatus = String(subscription?.status || '')
            .trim()
            .toUpperCase();
          if (persistedStatus !== subscriptionStatus) {
            Tenant.updateOne(
              { _id: tenantId },
              {
                $set: {
                  'subscription.status': subscriptionStatus,
                  'subscription.updatedAt': new Date(),
                },
              }
            ).catch((syncError) => {
              if (process.env.NODE_ENV === 'development') {
                console.error(
                  '[AUTH][LOGIN] Failed to sync subscription status:',
                  syncError?.message || syncError
                );
              }
            });
          }

          if (subscriptionStatus === SUBSCRIPTION_STATUSES.CANCELLED) {
            return res.status(403).json({
              error: SUBSCRIPTION_STATUS_MESSAGES[SUBSCRIPTION_STATUSES.CANCELLED],
              message: SUBSCRIPTION_STATUS_MESSAGES[SUBSCRIPTION_STATUSES.CANCELLED],
              subscriptionStatus,
            });
          }

          if (
            subscriptionStatus === SUBSCRIPTION_STATUSES.SUSPENDED &&
            BLOCK_SUSPENDED_LOGIN
          ) {
            return res.status(403).json({
              error: SUBSCRIPTION_STATUS_MESSAGES[SUBSCRIPTION_STATUSES.SUSPENDED],
              message: SUBSCRIPTION_STATUS_MESSAGES[SUBSCRIPTION_STATUSES.SUSPENDED],
              subscriptionStatus,
            });
          }

          if (subscriptionStatus === SUBSCRIPTION_STATUSES.EXPIRED) {
            subscriptionWarning =
              SUBSCRIPTION_STATUS_MESSAGES[SUBSCRIPTION_STATUSES.EXPIRED];
          } else if (subscriptionStatus === SUBSCRIPTION_STATUSES.SUSPENDED) {
            subscriptionWarning =
              SUBSCRIPTION_STATUS_MESSAGES[SUBSCRIPTION_STATUSES.SUSPENDED];
          }
        } catch (subscriptionError) {
          if (process.env.NODE_ENV === 'development') {
            console.error(
              '[AUTH][LOGIN] Subscription status resolution failed:',
              subscriptionError?.message || subscriptionError
            );
          }
        }
      }

      // Generate tokens with tenant info
      const accessToken = jwt.sign(
        {
          sub: user._id,
          email: user.email,
          name: user.name,
          role: user.role,
          tenantId: tenantId || null,
        },
        config.jwtSecret,
        { expiresIn: `${config.tokenTtlMinutes}m` }
      );

      const refreshTokenExpiresIn = rememberMe
        ? `${LONG_SESSION_REFRESH_TTL_DAYS}d`
        : `${SHORT_SESSION_REFRESH_TTL_HOURS}h`;
      const refreshToken = jwt.sign(
        { sub: user._id },
        config.jwtRefreshSecret,
        { expiresIn: refreshTokenExpiresIn }
      );

      setLoginAuditContext(req, {
        userId: user?._id ? String(user._id) : null,
        userName: user?.name || null,
        userEmail: user?.email || email || null,
        userRole: user?.role || null,
        tenantId: toTenantIdString(tenant?._id || tenantId || user?.tenantId),
      });

      res.json({
        accessToken,
        refreshToken,
        rememberMe,
        user: {
          _id: user._id,
          name: user.name,
          email: user.email,
          role: user.role,
          planType: user.planType,
          examsCreated: user.examsCreated ?? 0,
          tenantId: tenant?._id || null,
          tenant: tenant || null,
          subscriptionStatus,
          subscriptionWarning,
        },
        session: {
          rememberMe,
          refreshTokenExpiresIn,
        },
      });
    } catch (error) {
      next(error);
    }
  }
);

// Refresh token
router.post('/refresh', async (req, res, next) => {
  try {
    const { refreshToken } = req.body || {};
    if (!refreshToken) {
      return res.status(400).json({ error: 'Refresh token required' });
    }

    // Check if refresh token is blacklisted
    if (isBlacklisted(refreshToken)) {
      return res.status(401).json({ error: 'Refresh token has been invalidated' });
    }

    try {
      const decoded = jwt.verify(refreshToken, config.jwtRefreshSecret);
      const user = await User.findById(decoded.sub).select('-password');
      
      if (!user) {
        return res.status(401).json({ error: 'User not found' });
      }

      try {
        await ensureTrialAdminRole(user);
      } catch (roleError) {
        if (process.env.NODE_ENV === 'development') {
          console.error('[AUTH][REFRESH] Trial role sync failed:', roleError?.message || roleError);
        }
      }

      let tenant = null;
      try {
        tenant = await resolveTenantSnapshot(user.tenantId, 'name code status type');
      } catch (tenantResolveError) {
        if (process.env.NODE_ENV === 'development') {
          console.error('[AUTH][REFRESH] Tenant resolution failed:', tenantResolveError?.message || tenantResolveError);
        }
      }
      const tenantId = toTenantIdString(user.tenantId);
      let subscriptionStatus = SUBSCRIPTION_STATUSES.ACTIVE;
      let subscriptionWarning = '';

      if (tenantId && user.role !== 'SUPER_ADMIN') {
        try {
          const tenantSubscription = await Tenant.findById(tenantId).select('subscription').lean();
          const subscription = tenantSubscription?.subscription || {};
          subscriptionStatus = resolveSubscriptionStatus(subscription);

          if (subscriptionStatus === SUBSCRIPTION_STATUSES.CANCELLED) {
            return res.status(403).json({
              error: SUBSCRIPTION_STATUS_MESSAGES[SUBSCRIPTION_STATUSES.CANCELLED],
              message: SUBSCRIPTION_STATUS_MESSAGES[SUBSCRIPTION_STATUSES.CANCELLED],
              subscriptionStatus,
            });
          }

          if (
            subscriptionStatus === SUBSCRIPTION_STATUSES.SUSPENDED &&
            BLOCK_SUSPENDED_LOGIN
          ) {
            return res.status(403).json({
              error: SUBSCRIPTION_STATUS_MESSAGES[SUBSCRIPTION_STATUSES.SUSPENDED],
              message: SUBSCRIPTION_STATUS_MESSAGES[SUBSCRIPTION_STATUSES.SUSPENDED],
              subscriptionStatus,
            });
          }

          if (subscriptionStatus === SUBSCRIPTION_STATUSES.EXPIRED) {
            subscriptionWarning =
              SUBSCRIPTION_STATUS_MESSAGES[SUBSCRIPTION_STATUSES.EXPIRED];
          } else if (subscriptionStatus === SUBSCRIPTION_STATUSES.SUSPENDED) {
            subscriptionWarning =
              SUBSCRIPTION_STATUS_MESSAGES[SUBSCRIPTION_STATUSES.SUSPENDED];
          }
        } catch (subscriptionError) {
          if (process.env.NODE_ENV === 'development') {
            console.error(
              '[AUTH][REFRESH] Subscription status resolution failed:',
              subscriptionError?.message || subscriptionError
            );
          }
        }
      }

      const accessToken = jwt.sign(
        {
          sub: user._id,
          email: user.email,
          name: user.name,
          role: user.role,
          tenantId: tenantId || null,
        },
        config.jwtSecret,
        { expiresIn: `${config.tokenTtlMinutes}m` }
      );

      res.json({
        accessToken,
        user: {
          _id: user._id,
          name: user.name,
          email: user.email,
          role: user.role,
          planType: user.planType,
          examsCreated: user.examsCreated ?? 0,
          tenantId: tenant?._id || null,
          tenant: tenant || null,
          subscriptionStatus,
          subscriptionWarning,
        },
      });
    } catch (error) {
      return res.status(401).json({ error: 'Invalid refresh token' });
    }
  } catch (error) {
    next(error);
  }
});

// Logout (blacklist tokens to prevent reuse)
router.post('/logout', requireAuth, auditLogout, async (req, res) => {
  try {
    // Get tokens from request
    const authHeader = req.headers.authorization;
    const accessToken = authHeader?.replace('Bearer ', '');
    const refreshToken = req.body.refreshToken; // Client should send refresh token
    
    // Blacklist access token (if provided)
    if (accessToken) {
      // Access tokens expire in tokenTtlMinutes, convert to seconds
      const expiresInSeconds = config.tokenTtlMinutes * 60;
      addToBlacklist(accessToken, expiresInSeconds);
    }
    
    // Blacklist refresh token (if provided)
    if (refreshToken) {
      try {
        // Verify token to get expiry, then blacklist it
        const decoded = jwt.verify(refreshToken, config.jwtRefreshSecret);
        const nowInSeconds = Math.floor(Date.now() / 1000);
        const expiresInSeconds =
          Number.isFinite(decoded?.exp) && decoded.exp > nowInSeconds
            ? decoded.exp - nowInSeconds
            : config.refreshTtlDays * 24 * 60 * 60;
        if (expiresInSeconds > 0) {
          addToBlacklist(refreshToken, expiresInSeconds);
        }
      } catch (error) {
        // If refresh token is invalid, ignore (might already be expired)
        // Still proceed with logout
      }
    }
    
    res.json({ message: 'Logged out successfully' });
  } catch (error) {
    // Even if blacklisting fails, return success (client-side cleanup still works)
    res.json({ message: 'Logged out successfully' });
  }
});

// Get current user
router.get('/me', requireAuth, async (req, res, next) => {
  try {
    const user = await User.findById(req.user._id).select('-password');
    
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    await ensureTrialAdminRole(user);

    const userPayload = user.toObject();
    const tenant = await resolveTenantSnapshot(user.tenantId, 'name code status uniqueId type');

    res.json({
      user: {
        ...userPayload,
        tenantId: tenant?._id || null,
        tenant: tenant || null,
        subscriptionStatus: req.user?.subscriptionStatus || SUBSCRIPTION_STATUSES.ACTIVE,
        subscriptionWarning: req.user?.subscriptionWarning || '',
      },
    });
  } catch (error) {
    next(error);
  }
});

export default router;

