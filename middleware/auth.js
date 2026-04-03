import jwt from 'jsonwebtoken';
import config from '../config/env.js';
import User from '../models/User.js';
import Tenant from '../models/Tenant.js';
import {
  SUBSCRIPTION_STATUSES,
  SUBSCRIPTION_STATUS_MESSAGES,
  resolveSubscriptionStatus,
  resolveEffectivePlanType,
  resolveSubscriptionPlanType,
  isReadOnlyHttpMethod,
} from '../config/planLimits.js';
import { isBlacklisted } from '../utils/tokenBlacklist.js';
import { auditUnauthorized } from './audit.js';
import { validateTenantAccessState } from './tenantStatus.js';

const ALLOW_SUSPENDED_READ_ONLY =
  String(process.env.ALLOW_SUSPENDED_READ_ONLY || '')
    .trim()
    .toLowerCase() === 'true';

export const requireAuth = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      auditUnauthorized(req, res);
      return res.status(401).json({ error: 'Unauthorized - No token provided' });
    }

    const token = authHeader.replace('Bearer ', '');
    
    // Check if token is blacklisted
    if (isBlacklisted(token)) {
      return res.status(401).json({ error: 'Token has been invalidated' });
    }
    
    try {
      const decoded = jwt.verify(token, config.jwtSecret);
      
      // Optionally verify user still exists
      const user = await User.findById(decoded.sub).select('-password');
      if (!user) {
        return res.status(401).json({ error: 'User not found' });
      }

      // Check user status
      if (user.status && user.status !== 'ACTIVE' && user.role !== 'SUPER_ADMIN') {
        return res.status(403).json({ error: 'Account is not active' });
      }

      const tokenTenantId = decoded.tenantId ? String(decoded.tenantId) : null;
      const userTenantId = user.tenantId ? String(user.tenantId) : null;
      const tenantId = userTenantId || tokenTenantId || null;

      if (
        process.env.NODE_ENV === 'development' &&
        tokenTenantId &&
        userTenantId &&
        tokenTenantId !== userTenantId
      ) {
        console.warn(
          `[auth] token tenantId mismatch for user ${user._id}: token=${tokenTenantId} db=${userTenantId}. Using DB tenantId.`
        );
      }
      let effectivePlanType = user.planType;
      let subscriptionStatus = SUBSCRIPTION_STATUSES.ACTIVE;
      let subscriptionPlanType = null;
      let subscriptionExpiresAt = null;
      let subscriptionCustomLimits = {};
      let subscriptionCustomFeatures = {};
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

        try {
          const tenant = tenantAccessState.tenant;
          const subscription = tenant?.subscription || {};
          subscriptionStatus = resolveSubscriptionStatus(subscription);
          subscriptionPlanType = resolveSubscriptionPlanType(subscription.planType || user.planType);
          subscriptionExpiresAt = subscription.expiresAt || null;
          subscriptionCustomLimits =
            subscription?.customLimits &&
            typeof subscription.customLimits === 'object' &&
            !Array.isArray(subscription.customLimits)
              ? subscription.customLimits
              : {};
          subscriptionCustomFeatures =
            subscription?.customFeatures &&
            typeof subscription.customFeatures === 'object' &&
            !Array.isArray(subscription.customFeatures)
              ? subscription.customFeatures
              : {};
          effectivePlanType = resolveEffectivePlanType(subscriptionPlanType, subscriptionStatus);

          const persistedStatus = String(subscription?.status || '')
            .trim()
            .toUpperCase();
          if (tenant?._id && persistedStatus !== subscriptionStatus) {
            Tenant.updateOne(
              { _id: tenant._id },
              {
                $set: {
                  'subscription.status': subscriptionStatus,
                  'subscription.updatedAt': new Date(),
                },
              }
            ).catch((syncError) => {
              console.error(
                '[auth] failed to sync tenant subscription status:',
                syncError?.message || syncError
              );
            });
          }

          if (subscriptionStatus === SUBSCRIPTION_STATUSES.SUSPENDED) {
            const readOnlyRequest = isReadOnlyHttpMethod(req.method);
            const canProceed = ALLOW_SUSPENDED_READ_ONLY && readOnlyRequest;
            if (!canProceed) {
              return res.status(403).json({
                success: false,
                error: SUBSCRIPTION_STATUS_MESSAGES[SUBSCRIPTION_STATUSES.SUSPENDED],
                message: SUBSCRIPTION_STATUS_MESSAGES[SUBSCRIPTION_STATUSES.SUSPENDED],
                subscriptionStatus,
              });
            }
            subscriptionWarning = SUBSCRIPTION_STATUS_MESSAGES[SUBSCRIPTION_STATUSES.SUSPENDED];
          }

          if (subscriptionStatus === SUBSCRIPTION_STATUSES.CANCELLED) {
            return res.status(403).json({
              success: false,
              error: SUBSCRIPTION_STATUS_MESSAGES[SUBSCRIPTION_STATUSES.CANCELLED],
              message: SUBSCRIPTION_STATUS_MESSAGES[SUBSCRIPTION_STATUSES.CANCELLED],
              subscriptionStatus,
            });
          }

          if (subscriptionStatus === SUBSCRIPTION_STATUSES.EXPIRED) {
            const readOnlyRequest = isReadOnlyHttpMethod(req.method);
            if (!readOnlyRequest) {
              return res.status(403).json({
                success: false,
                error: SUBSCRIPTION_STATUS_MESSAGES[SUBSCRIPTION_STATUSES.EXPIRED],
                message: SUBSCRIPTION_STATUS_MESSAGES[SUBSCRIPTION_STATUSES.EXPIRED],
                subscriptionStatus,
              });
            }
            subscriptionWarning = SUBSCRIPTION_STATUS_MESSAGES[SUBSCRIPTION_STATUSES.EXPIRED];
          }

          res.setHeader('x-subscription-status', subscriptionStatus);
          if (subscriptionWarning) {
            res.setHeader('x-subscription-warning', subscriptionWarning);
          }
        } catch (error) {
          // Fall back to user planType if tenant lookup fails
          effectivePlanType = user.planType;
        }
      }

      req.user = {
        ...decoded,
        _id: decoded.sub,
        role: user.role,
        tenantId,
        planType: effectivePlanType,
        subscriptionStatus,
        subscriptionPlanType,
        subscriptionExpiresAt,
        subscriptionCustomLimits,
        subscriptionCustomFeatures,
        subscriptionWarning,
      };
      next();
    } catch (error) {
      auditUnauthorized(req, res);
      if (error.name === 'TokenExpiredError') {
        return res.status(401).json({ error: 'Token expired' });
      }
      return res.status(401).json({ error: 'Invalid token' });
    }
  } catch (error) {
    return res.status(500).json({ error: 'Authentication error' });
  }
};

export const optionalAuth = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      const token = authHeader.replace('Bearer ', '');
      try {
        const decoded = jwt.verify(token, config.jwtSecret);
        const user = await User.findById(decoded.sub).select('-password');
        if (user) {
          req.user = {
            ...decoded,
            _id: decoded.sub,
          };
        }
      } catch (error) {
        // Ignore token errors for optional auth
      }
    }
    next();
  } catch (error) {
    next();
  }
};

