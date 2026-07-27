import express from 'express';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import nodemailer from 'nodemailer';
import dotenv from 'dotenv';
import config from '../config/env.js';
import User from '../models/User.js';
import Tenant from '../models/Tenant.js';
import { requireAuth } from '../middleware/auth.js';
import { body, validationResult } from 'express-validator';
import { addToBlacklist, isBlacklisted } from '../utils/tokenBlacklist.js';
import { validatePasswordStrength as validatePassword } from '../utils/passwordValidator.js';
import { auditLogin, auditLogout, AUDIT_ACTIONS } from '../middleware/audit.js';
import { logAuditEvent } from '../utils/auditLogger.js';
import { resolveTenantSnapshot } from '../utils/tenantResolver.js';
import {
  TENANT_INACTIVE_LOGIN_MESSAGE,
  normalizeTenantTokenVersion,
  validateTenantAccessState,
} from '../middleware/tenantStatus.js';
import {
  isFreePlan,
  isTrialRestrictedPlan,
  resolveSubscriptionStatus,
  SUBSCRIPTION_STATUSES,
  SUBSCRIPTION_STATUS_MESSAGES,
} from '../config/planLimits.js';

dotenv.config();

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

        // Keep login fast: fire notifications asynchronously after tenant bootstrap succeeds.
        setImmediate(async () => {
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
        });

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
const PASSWORD_RESET_TOKEN_TTL_MINUTES = parsePositiveInteger(
  process.env.PASSWORD_RESET_TOKEN_TTL_MINUTES,
  60
);
const PASSWORD_RESET_TOKEN_TTL_MS = PASSWORD_RESET_TOKEN_TTL_MINUTES * 60 * 1000;
const LOGIN_STEP_WARN_THRESHOLD_MS = parsePositiveInteger(
  process.env.LOGIN_STEP_WARN_THRESHOLD_MS,
  400
);
const LOGIN_TARGET_RESPONSE_MS = parsePositiveInteger(
  process.env.LOGIN_TARGET_RESPONSE_MS,
  2000
);
const FORGOT_PASSWORD_GENERIC_MESSAGE =
  'If this email exists, a reset link has been sent';

let passwordResetTransporter = null;
let passwordResetTransporterPromise = null;

const hashResetToken = (token) =>
  crypto.createHash('sha256').update(String(token || '')).digest('hex');

const resolveSingleUrlCandidate = (value) => {
  const raw = String(value || '').trim();
  if (!raw) return '';

  let candidates = [];
  if (raw.startsWith('[') && raw.endsWith(']')) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        candidates = parsed
          .map((item) => String(item || '').trim())
          .filter(Boolean);
      }
    } catch (_) {
      // Fall back to comma-split parsing below.
    }
  }

  if (!candidates.length) {
    candidates = raw
      .split(',')
      .map((item) => String(item || '').trim())
      .filter(Boolean);
  }

  const cleanedCandidates = candidates
    .map((item) => item.replace(/^['"]|['"]$/g, ''))
    .filter(Boolean);

  if (!cleanedCandidates.length) return '';

  const httpCandidate = cleanedCandidates.find((item) => /^https?:\/\//i.test(item));
  return httpCandidate || cleanedCandidates[0];
};

const resolveFrontendBaseUrl = () => {
  const candidates = [
    process.env.FRONTEND_URL,
    process.env.CLIENT_URL,
    config.corsOrigin,
    config.appBaseUrl,
    'http://localhost:5173',
  ];

  for (const candidate of candidates) {
    const resolved = resolveSingleUrlCandidate(candidate);
    if (resolved) {
      return resolved.replace(/\/+$/, '');
    }
  }

  return 'http://localhost:5173';
};

const resolveMailTransporter = async () => {
  if (passwordResetTransporter) {
    return passwordResetTransporter;
  }

  if (passwordResetTransporterPromise) {
    return passwordResetTransporterPromise;
  }

  passwordResetTransporterPromise = (async () => {
    const emailUser = String(process.env.EMAIL || '').trim();
    const appPassword = String(process.env.APP_PASSWORD || '').trim();
    const resendApiKey = String(process.env.RESEND_API_KEY || '').trim();
    const resendSmtpUser = String(process.env.RESEND_SMTP_USER || 'resend').trim();
    const resendSmtpHost = String(process.env.RESEND_SMTP_HOST || 'smtp.resend.com').trim();
    const resendSmtpPort = Number(process.env.RESEND_SMTP_PORT || 465);

    let transporter = null;
    let transportLabel = '';

    if (emailUser && appPassword) {
      transporter = nodemailer.createTransport({
        host: 'smtp.gmail.com',
        port: 465,
        secure: true,
        auth: {
          user: emailUser,
          pass: appPassword,
        },
      });
      transportLabel = 'Gmail SMTP';
    } else if (resendApiKey) {
      transporter = nodemailer.createTransport({
        host: resendSmtpHost,
        port: resendSmtpPort,
        secure: resendSmtpPort === 465,
        auth: {
          user: resendSmtpUser,
          pass: resendApiKey,
        },
      });
      transportLabel = 'Resend SMTP';
    } else {
      throw new Error(
        'Mail transporter is not configured. Set EMAIL+APP_PASSWORD (Gmail) or RESEND_API_KEY (Resend SMTP) in .env.'
      );
    }

    if (!transporter || typeof transporter.sendMail !== 'function') {
      throw new Error('Mail transporter is not configured.');
    }

    await transporter.verify();
    console.info(`[AUTH][MAIL] ${transportLabel} transporter verified successfully.`);

    passwordResetTransporter = transporter;
    return passwordResetTransporter;
  })();

  try {
    return await passwordResetTransporterPromise;
  } catch (error) {
    passwordResetTransporter = null;
    passwordResetTransporterPromise = null;
    throw error;
  }
};

const sendPasswordResetEmail = async ({ toEmail, resetLink }) => {
  try {
    const transporter = await resolveMailTransporter();
    if (!transporter || typeof transporter.sendMail !== 'function') {
      throw new Error('Mail transporter is not configured.');
    }

    const fromAddress = String(
      process.env.SMTP_FROM ||
      process.env.MAIL_FROM ||
      process.env.EMAIL_FROM ||
      process.env.EMAIL ||
      process.env.EMAIL_USER ||
      process.env.EMAIL_ADDRESS ||
      process.env.GMAIL_USER ||
      process.env.MAIL_USER ||
      process.env.MAIL_USERNAME ||
      process.env.SMTP_USER ||
      'no-reply@exam-management.local'
    ).trim();

    const mailInfo = await transporter.sendMail({
      from: fromAddress,
      to: toEmail,
      subject: 'Reset your password',
      text: `You requested a password reset. Use this link to reset your password: ${resetLink}\n\nThis link expires in ${PASSWORD_RESET_TOKEN_TTL_MINUTES} minutes.`,
      html: `
        <div style="font-family: Arial, sans-serif; color: #0f172a;">
          <h2 style="margin-bottom: 8px;">Reset your password</h2>
          <p style="margin: 0 0 12px;">You requested a password reset.</p>
          <p style="margin: 0 0 16px;">
            <a href="${resetLink}" style="display:inline-block;padding:10px 16px;background:#2563eb;color:#ffffff;text-decoration:none;border-radius:8px;">
              Reset Password
            </a>
          </p>
          <p style="margin: 0 0 8px;">Or copy and paste this link into your browser:</p>
          <p style="margin: 0 0 16px;word-break:break-all;">${resetLink}</p>
          <p style="margin: 0;">This link expires in ${PASSWORD_RESET_TOKEN_TTL_MINUTES} minutes.</p>
        </div>
      `,
    });

    console.info(
      `[AUTH][FORGOT_PASSWORD] Reset email sent to ${toEmail}. Message ID: ${mailInfo?.messageId || 'N/A'}`
    );
    return true;
  } catch (error) {
    console.error('[AUTH][FORGOT_PASSWORD] sendMail failed:', error?.message || error);
    throw error;
  }
};

const resolveAuditClientIp = (req) => {
  const forwarded = req.headers?.['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.trim()) {
    return forwarded.split(',')[0].trim();
  }
  return req.ip || req.connection?.remoteAddress || req.socket?.remoteAddress || null;
};

const logPasswordAuditEvent = (
  action,
  req,
  { userId = null, email = null, tenantId = null, status = 'SUCCESS', statusCode = null } = {}
) => {
  const ipAddress = resolveAuditClientIp(req);
  logAuditEvent(action, {
    userId: userId || null,
    userEmail: email || null,
    email: email || null,
    tenantId: tenantId || null,
    resourceType: 'User',
    resourceId: userId || null,
    method: req.method,
    path: req.path,
    status,
    statusCode,
    ip: ipAddress,
    ipAddress,
    userAgent: req.get('user-agent') || null,
    timestamp: new Date(),
  }).catch((error) => {
    console.error(`[AUTH][AUDIT] Failed to log ${action}:`, error?.message || error);
  });
};

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

const nowMsFromNs = (ns) => Number(ns) / 1e6;

const createLoginProfiler = ({ email }) => {
  const startedAtNs = process.hrtime.bigint();
  let previousAtNs = startedAtNs;
  const requestId = crypto.randomBytes(4).toString('hex');
  const maskedEmail = String(email || '').trim().toLowerCase();

  const mark = (step, meta = null) => {
    const currentNs = process.hrtime.bigint();
    const stepDurationMs = nowMsFromNs(currentNs - previousAtNs);
    const totalDurationMs = nowMsFromNs(currentNs - startedAtNs);
    previousAtNs = currentNs;
    const metaText =
      meta && typeof meta === 'object' && Object.keys(meta).length > 0
        ? ` meta=${JSON.stringify(meta)}`
        : '';
    const logMethod =
      stepDurationMs >= LOGIN_STEP_WARN_THRESHOLD_MS ? console.warn : console.log;
    logMethod(
      `[AUTH][LOGIN][${requestId}] step=${step} stepMs=${stepDurationMs.toFixed(1)} totalMs=${totalDurationMs.toFixed(1)} email=${maskedEmail}${metaText}`
    );
  };

  const finish = (result = 'success', meta = null) => {
    const currentNs = process.hrtime.bigint();
    const totalDurationMs = nowMsFromNs(currentNs - startedAtNs);
    const metaText =
      meta && typeof meta === 'object' && Object.keys(meta).length > 0
        ? ` meta=${JSON.stringify(meta)}`
        : '';
    const logMethod =
      totalDurationMs >= LOGIN_TARGET_RESPONSE_MS ? console.warn : console.log;
    logMethod(
      `[AUTH][LOGIN][${requestId}] completed result=${result} totalMs=${totalDurationMs.toFixed(1)} targetMs=${LOGIN_TARGET_RESPONSE_MS}${metaText}`
    );
  };

  mark('request_received');
  return { mark, finish, requestId };
};

let userEmailIndexCheckInFlight = null;
let userEmailIndexEnsured = false;
const ensureUserEmailIndex = async () => {
  if (userEmailIndexEnsured) {
    return;
  }
  if (userEmailIndexCheckInFlight) {
    return userEmailIndexCheckInFlight;
  }

  userEmailIndexCheckInFlight = (async () => {
    try {
      await User.collection.createIndex(
        { email: 1 },
        { name: 'email_1', unique: true, background: true }
      );
      userEmailIndexEnsured = true;
      console.log('[AUTH][LOGIN] Ensured index email_1 on users collection');
    } catch (error) {
      const message = String(error?.message || '').toLowerCase();
      // Ignore expected "already exists" variants and move on.
      if (!message.includes('already exists') && !message.includes('index key specs conflict')) {
        console.error('[AUTH][LOGIN] Failed to ensure email index:', error?.message || error);
      }
    }
  })()
    .catch(() => {})
    .finally(() => {
      userEmailIndexCheckInFlight = null;
    });

  return userEmailIndexCheckInFlight;
};

const buildAccessTokenPayload = ({ user, tenantId, tokenVersion }) => {
  const payload = {
    sub: user._id,
    email: user.email,
    name: user.name,
    role: user.role,
    // Informational only — middleware/auth.js's requireAuth always re-derives
    // req.user.roles from a fresh DB read on every request, the same way it
    // already does for `role`, so a role change takes effect immediately
    // without waiting for the next token refresh.
    roles: user.roles && user.roles.length ? user.roles : [user.role],
    tenantId: tenantId || null,
  };

  if (tenantId) {
    payload.tokenVersion = normalizeTenantTokenVersion(tokenVersion);
  }

  return payload;
};

const buildRefreshTokenPayload = ({ userId, tenantId, tokenVersion }) => {
  const payload = { sub: userId };

  if (tenantId) {
    payload.tenantId = tenantId;
    payload.tokenVersion = normalizeTenantTokenVersion(tokenVersion);
  }

  return payload;
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
      let tenantTokenVersion = 0;

      if (tenantId) {
        const tenantAccessState = await validateTenantAccessState({
          tenantId,
          select: 'status tokenVersion',
          inactiveMessage: TENANT_INACTIVE_LOGIN_MESSAGE,
          skipTokenVersionCheck: true,
        });
        if (!tenantAccessState.allowed) {
          return res.status(tenantAccessState.statusCode).json(tenantAccessState.payload);
        }
        tenantTokenVersion = normalizeTenantTokenVersion(tenantAccessState.tenant?.tokenVersion);
      }

      // Generate tokens with tenant info
      const accessToken = jwt.sign(
        buildAccessTokenPayload({
          user,
          tenantId,
          tokenVersion: tenantTokenVersion,
        }),
        config.jwtSecret,
        { expiresIn: `${config.tokenTtlMinutes}m` }
      );

      const refreshToken = jwt.sign(
        buildRefreshTokenPayload({
          userId: user._id,
          tenantId,
          tokenVersion: tenantTokenVersion,
        }),
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
          roles: user.roles && user.roles.length ? user.roles : [user.role],
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
    let loginProfiler = null;
    try {
      const rawEmailInput = String(req.body?.email || '').trim();
      loginProfiler = createLoginProfiler({ email: rawEmailInput });
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        loginProfiler.mark('validation_failed', {
          errorCount: errors.array().length,
        });
        loginProfiler.finish('validation_failed', { statusCode: 400 });
        return res.status(400).json({ errors: errors.array() });
      }

      const email = rawEmailInput.toLowerCase();
      const { password } = req.body;
      const rememberMe = resolveRememberMeFlag(req.body?.rememberMe);
      loginProfiler.mark('validation_passed', { rememberMe });
      setLoginAuditContext(req, { userEmail: email || null });

      // Ensure login lookup remains indexed even on older deployments.
      ensureUserEmailIndex().catch(() => {});

      // Find user
      loginProfiler.mark('user_lookup_start');
      let user = await User.findOne({ email }).select(
        'name email password role tenantId status planType examsCreated'
      );
      loginProfiler.mark('user_lookup_done', { found: Boolean(user) });
      if (!user && rawEmailInput && rawEmailInput !== email) {
        loginProfiler.mark('user_lookup_raw_fallback_start');
        user = await User.findOne({ email: rawEmailInput.trim() }).select(
          'name email password role tenantId status planType examsCreated'
        );
        loginProfiler.mark('user_lookup_raw_fallback_done', {
          found: Boolean(user),
        });
      }
      if (!user) {
        loginProfiler.finish('invalid_credentials', {
          reason: 'user_not_found',
          statusCode: 401,
        });
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
        loginProfiler.mark('password_verification_start');
        isMatch = await verifyPasswordSafely(user, password);
        loginProfiler.mark('password_verification_done', { isMatch });
      } catch (passwordError) {
        console.error('[AUTH][LOGIN] Password verification failed:', passwordError?.message || passwordError);
        loginProfiler.finish('invalid_credentials', {
          reason: 'password_verification_error',
          statusCode: 401,
        });
        return res.status(401).json({ error: 'Invalid credentials' });
      }
      if (!isMatch) {
        loginProfiler.finish('invalid_credentials', {
          reason: 'password_mismatch',
          statusCode: 401,
        });
        return res.status(401).json({ error: 'Invalid credentials' });
      }

      // Check user status
      if (user.status && user.status !== 'ACTIVE' && user.role !== 'SUPER_ADMIN') {
        loginProfiler.finish('forbidden', {
          reason: 'inactive_account',
          statusCode: 403,
        });
        return res.status(403).json({ error: 'Account is not active' });
      }

      if (
        isTrialRestrictedPlan(user.planType) &&
        ['EXAM_CREATOR', 'TENANT_ADMIN'].includes(user.role) &&
        !user.tenantId
      ) {
        try {
          loginProfiler.mark('trial_tenant_bootstrap_start');
          await ensureTrialTenant({ user });
          loginProfiler.mark('trial_tenant_bootstrap_done', {
            tenantId: toTenantIdString(user.tenantId),
          });
        } catch (tenantError) {
          console.error('[AUTH][LOGIN] Trial tenant bootstrap failed:', tenantError?.message || tenantError);
          loginProfiler.finish('tenant_bootstrap_failed', { statusCode: 503 });
          return res.status(503).json({
            error: 'Unable to initialize tenant workspace. Please try again.',
          });
        }
      }

      try {
        loginProfiler.mark('trial_role_sync_start');
        await ensureTrialAdminRole(user);
        setLoginAuditContext(req, {
          userRole: user?.role || null,
          tenantId: toTenantIdString(user?.tenantId),
        });
        loginProfiler.mark('trial_role_sync_done', { role: user?.role || null });
      } catch (roleError) {
        console.error('[AUTH][LOGIN] Trial role sync failed:', roleError?.message || roleError);
      }

      let tenant = null;
      const tenantId = toTenantIdString(user.tenantId);
      let tenantTokenVersion = 0;
      let tenantSecuritySnapshot = null;
      let subscriptionStatus = SUBSCRIPTION_STATUSES.ACTIVE;
      let subscriptionWarning = '';

      if (tenantId && user.role !== 'SUPER_ADMIN') {
        loginProfiler.mark('tenant_access_validation_start');
        const tenantAccessState = await validateTenantAccessState({
          tenantId,
          select: 'name code status type tokenVersion subscription',
          inactiveMessage: TENANT_INACTIVE_LOGIN_MESSAGE,
          skipTokenVersionCheck: true,
        });
        loginProfiler.mark('tenant_access_validation_done', {
          allowed: tenantAccessState.allowed,
        });
        if (!tenantAccessState.allowed) {
          loginProfiler.finish('tenant_access_denied', {
            statusCode: tenantAccessState.statusCode,
          });
          return res.status(tenantAccessState.statusCode).json(tenantAccessState.payload);
        }

        tenantSecuritySnapshot = tenantAccessState.tenant;
        if (tenantSecuritySnapshot?._id) {
          tenant = {
            _id: tenantSecuritySnapshot._id,
            name: tenantSecuritySnapshot.name,
            code: tenantSecuritySnapshot.code,
            status: tenantSecuritySnapshot.status,
            type: tenantSecuritySnapshot.type,
          };
        }
        tenantTokenVersion = normalizeTenantTokenVersion(
          tenantSecuritySnapshot?.tokenVersion
        );

        loginProfiler.mark('subscription_status_resolution_start');
        try {
          const subscription = tenantSecuritySnapshot?.subscription || {};
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
          console.error(
            '[AUTH][LOGIN] Subscription status resolution failed:',
            subscriptionError?.message || subscriptionError
          );
        }
        loginProfiler.mark('subscription_status_resolution_done', {
          subscriptionStatus,
        });
      } else if (tenantId) {
        try {
          loginProfiler.mark('tenant_snapshot_fallback_start');
          tenant = await resolveTenantSnapshot(user.tenantId, 'name code status type');
          loginProfiler.mark('tenant_snapshot_fallback_done', {
            found: Boolean(tenant),
          });
        } catch (tenantResolveError) {
          console.error('[AUTH][LOGIN] Tenant resolution failed:', tenantResolveError?.message || tenantResolveError);
        }
      }

      // Generate tokens with tenant info
      loginProfiler.mark('token_generation_start');
      const accessToken = jwt.sign(
        buildAccessTokenPayload({
          user,
          tenantId,
          tokenVersion: tenantTokenVersion,
        }),
        config.jwtSecret,
        { expiresIn: `${config.tokenTtlMinutes}m` }
      );

      const refreshTokenExpiresIn = rememberMe
        ? `${LONG_SESSION_REFRESH_TTL_DAYS}d`
        : `${SHORT_SESSION_REFRESH_TTL_HOURS}h`;
      const refreshToken = jwt.sign(
        buildRefreshTokenPayload({
          userId: user._id,
          tenantId,
          tokenVersion: tenantTokenVersion,
        }),
        config.jwtRefreshSecret,
        { expiresIn: refreshTokenExpiresIn }
      );
      loginProfiler.mark('token_generation_done');

      setLoginAuditContext(req, {
        userId: user?._id ? String(user._id) : null,
        userName: user?.name || null,
        userEmail: user?.email || email || null,
        userRole: user?.role || null,
        tenantId: toTenantIdString(tenant?._id || tenantId || user?.tenantId),
      });

      loginProfiler.finish('success', {
        statusCode: 200,
        role: user?.role || null,
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
          roles: user.roles && user.roles.length ? user.roles : [user.role],
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
      console.error('[AUTH][LOGIN] Unhandled login error:', error?.message || error);
      loginProfiler?.finish('error', { statusCode: 500 });
      return res.status(500).json({
        error: 'Login failed. Please try again.',
      });
    }
  }
);

// Forgot password - send reset link without exposing user existence
router.post(
  '/forgot-password',
  [body('email').isEmail().normalizeEmail().withMessage('Valid email is required')],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        const attemptedEmail = String(req.body?.email || '').trim().toLowerCase();
        logPasswordAuditEvent(AUDIT_ACTIONS.FORGOT_PASSWORD_REQUEST, req, {
          email: attemptedEmail || null,
          status: 'FAILED',
          statusCode: 400,
        });
        return res.status(400).json({ errors: errors.array() });
      }

      const email = String(req.body?.email || '').trim().toLowerCase();
      const user = email ? await User.findOne({ email }) : null;

      if (user) {
        const rawToken = crypto.randomBytes(32).toString('hex');
        const hashedToken = hashResetToken(rawToken);
        const resetTokenExpiry = new Date(Date.now() + PASSWORD_RESET_TOKEN_TTL_MS);

        user.resetToken = hashedToken;
        user.resetTokenExpiry = resetTokenExpiry;
        await user.save();

        const resetLink = `${resolveFrontendBaseUrl()}/reset-password?token=${encodeURIComponent(rawToken)}`;
        try {
          await sendPasswordResetEmail({
            toEmail: user.email,
            resetLink,
          });
          logPasswordAuditEvent(AUDIT_ACTIONS.FORGOT_PASSWORD_REQUEST, req, {
            userId: user?._id ? String(user._id) : null,
            email: user.email,
            tenantId: toTenantIdString(user?.tenantId),
            status: 'SUCCESS',
            statusCode: 200,
          });
        } catch (mailError) {
          console.error('[AUTH][FORGOT_PASSWORD] Failed to send reset email:', mailError?.message || mailError);
          logPasswordAuditEvent(AUDIT_ACTIONS.FORGOT_PASSWORD_REQUEST, req, {
            userId: user?._id ? String(user._id) : null,
            email: user.email,
            tenantId: toTenantIdString(user?.tenantId),
            status: 'FAILED',
            statusCode: 500,
          });
          return res.status(500).json({
            success: false,
            message: 'Failed to send reset link. Please try again.',
          });
        }
      } else {
        logPasswordAuditEvent(AUDIT_ACTIONS.FORGOT_PASSWORD_REQUEST, req, {
          email: email || null,
          status: 'FAILED',
          statusCode: 404,
        });
      }

      return res.json({
        success: true,
        message: FORGOT_PASSWORD_GENERIC_MESSAGE,
      });
    } catch (error) {
      const attemptedEmail = String(req.body?.email || '').trim().toLowerCase();
      logPasswordAuditEvent(AUDIT_ACTIONS.FORGOT_PASSWORD_REQUEST, req, {
        email: attemptedEmail || null,
        status: 'FAILED',
        statusCode: 500,
      });
      next(error);
    }
  }
);

// Reset password using token
router.post(
  '/reset-password',
  [
    body('token').trim().notEmpty().withMessage('Reset token is required'),
    body('newPassword')
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
        const attemptedEmail = String(req.body?.email || '').trim().toLowerCase();
        logPasswordAuditEvent(AUDIT_ACTIONS.PASSWORD_RESET_SUCCESS, req, {
          email: attemptedEmail || null,
          status: 'FAILED',
          statusCode: 400,
        });
        return res.status(400).json({ errors: errors.array() });
      }

      const rawToken = String(req.body?.token || '').trim();
      const hashedToken = hashResetToken(rawToken);
      const newPassword = String(req.body?.newPassword || '');

      const user = await User.findOne({
        resetToken: hashedToken,
        resetTokenExpiry: { $gt: new Date() },
      });

      if (!user) {
        const attemptedEmail = String(req.body?.email || '').trim().toLowerCase();
        logPasswordAuditEvent(AUDIT_ACTIONS.PASSWORD_RESET_SUCCESS, req, {
          email: attemptedEmail || null,
          status: 'FAILED',
          statusCode: 400,
        });
        return res.status(400).json({
          success: false,
          message: 'Invalid or expired reset token',
        });
      }

      user.password = newPassword;
      user.resetToken = null;
      user.resetTokenExpiry = null;
      await user.save();

      logPasswordAuditEvent(AUDIT_ACTIONS.PASSWORD_RESET_SUCCESS, req, {
        userId: user?._id ? String(user._id) : null,
        email: user.email || null,
        tenantId: toTenantIdString(user?.tenantId),
        status: 'SUCCESS',
        statusCode: 200,
      });

      return res.json({
        success: true,
        message: 'Password reset successful',
      });
    } catch (error) {
      const attemptedEmail = String(req.body?.email || '').trim().toLowerCase();
      logPasswordAuditEvent(AUDIT_ACTIONS.PASSWORD_RESET_SUCCESS, req, {
        email: attemptedEmail || null,
        status: 'FAILED',
        statusCode: 500,
      });
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
      let tenantTokenVersion = 0;
      let tenantSecuritySnapshot = null;
      let subscriptionStatus = SUBSCRIPTION_STATUSES.ACTIVE;
      let subscriptionWarning = '';

      if (tenantId && user.role !== 'SUPER_ADMIN') {
        const tenantAccessState = await validateTenantAccessState({
          tenantId,
          decodedTokenVersion: decoded.tokenVersion,
          select: 'status tokenVersion subscription',
        });
        if (!tenantAccessState.allowed) {
          return res.status(tenantAccessState.statusCode).json(tenantAccessState.payload);
        }

        tenantSecuritySnapshot = tenantAccessState.tenant;
        tenantTokenVersion = normalizeTenantTokenVersion(
          tenantSecuritySnapshot?.tokenVersion
        );

        try {
          const subscription = tenantSecuritySnapshot?.subscription || {};
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
        buildAccessTokenPayload({
          user,
          tenantId,
          tokenVersion: tenantTokenVersion,
        }),
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
          roles: user.roles && user.roles.length ? user.roles : [user.role],
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

