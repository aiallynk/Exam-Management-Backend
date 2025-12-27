/**
 * Multi-Tenant Middleware
 * Ensures data isolation between tenants
 * Users belong to a single tenant (except SUPER_ADMIN)
 */

import User from '../models/User.js';
import Tenant from '../models/Tenant.js';

/**
 * Middleware to ensure user has tenantId (except SUPER_ADMIN)
 * Populates req.user with full user document including tenant info
 */
export const requireTenant = async (req, res, next) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    // SUPER_ADMIN can access everything
    if (req.user.role === 'SUPER_ADMIN') {
      return next();
    }

    // Load full user document to get tenantId
    const user = await User.findById(req.user._id)
      .populate('tenantId', 'name code status uniqueId type');

    if (!user) {
      return res.status(401).json({ error: 'User not found' });
    }

    // Check if user is active
    if (user.status !== 'ACTIVE') {
      return res.status(403).json({ error: 'Account is not active' });
    }

    // Allow users without tenant initially (they can be assigned later by Super Admin)
    // Users without tenant can still login, but won't be able to access tenant-specific routes
    if (user.tenantId) {
      // Check tenant status
      if (user.tenantId.status !== 'ACTIVE') {
        return res.status(403).json({ error: 'Tenant is not active' });
      }
    }

    // Update req.user with full user data
    req.user = {
      ...req.user,
      tenantId: user.tenantId?._id || null,
      tenant: user.tenantId || null,
    };

    next();
  } catch (error) {
    return res.status(500).json({ error: 'Multi-tenant validation error' });
  }
};

/**
 * Legacy alias for backward compatibility
 * @deprecated Use requireTenant instead
 */
export const requireOrganization = requireTenant;

/**
 * Middleware to filter queries by tenant boundaries
 * Automatically adds tenantId filter to queries
 */
export const enforceTenantBoundaries = async (req, res, next) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    // SUPER_ADMIN can see everything - no filtering
    if (req.user.role === 'SUPER_ADMIN') {
      req.tenantFilter = {};
      return next();
    }

    // User belongs to a tenant
    const tenantId = req.user.tenantId;

    if (!tenantId) {
      return res.status(403).json({ error: 'User must belong to a tenant' });
    }

    // Build filter based on tenant
    req.tenantFilter = {
      tenantId: tenantId,
    };

    next();
  } catch (error) {
    return res.status(500).json({ error: 'Tenant boundary enforcement error' });
  }
};

/**
 * Helper function to validate tenant access
 * Used in route handlers to ensure users can only access their own tenant data
 */
export const validateTenantAccess = async (resource, user) => {
  // SUPER_ADMIN can access everything
  if (user.role === 'SUPER_ADMIN') {
    return true;
  }

  // User belongs to a tenant
  const userTenantId = user.tenantId;

  if (!userTenantId) {
    return false;
  }

  // Resource must belong to the same tenant
  const resourceTenantId = resource.tenantId?.toString();
  const userTenantIdStr = userTenantId.toString();
  
  return resourceTenantId === userTenantIdStr;
};
