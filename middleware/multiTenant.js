/**
 * Multi-Tenant Middleware
 * Ensures data isolation between organizations and institutes
 * NOTE: Organization and Institute are EQUAL LEVEL personas (not hierarchical)
 * Users belong to EITHER Organization OR Institute (not both)
 */

import User from '../models/User.js';
import Organization from '../models/Organization.js';
import Institute from '../models/Institute.js';

/**
 * Middleware to ensure user has organizationId OR instituteId (except SUPER_ADMIN)
 * Populates req.user with full user document including organization/institute info
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

    // Load full user document to get organizationId/instituteId
    const user = await User.findById(req.user._id)
      .populate('organizationId', 'name code status uniqueId')
      .populate('instituteId', 'name code status uniqueId');

    if (!user) {
      return res.status(401).json({ error: 'User not found' });
    }

    // Check if user is active
    if (user.status !== 'ACTIVE') {
      return res.status(403).json({ error: 'Account is not active' });
    }

    // User must belong to EITHER organization OR institute (not both)
    // Allow users without tenant initially (they can be assigned later by Super Admin)
    const hasOrg = !!user.organizationId;
    const hasInst = !!user.instituteId;

    // Only enforce tenant requirement for routes that actually need it
    // Users without tenant can still login, but won't be able to access tenant-specific routes
    // This allows Super Admin to assign them later
    // if (!hasOrg && !hasInst) {
    //   return res.status(403).json({ error: 'User must be assigned to either an Organization or an Institute' });
    // }

    if (hasOrg && hasInst) {
      return res.status(403).json({ error: 'User cannot belong to both Organization and Institute. Data integrity error.' });
    }

    // Check tenant status
    if (hasOrg && user.organizationId.status !== 'ACTIVE') {
      return res.status(403).json({ error: 'Organization is not active' });
    }

    if (hasInst && user.instituteId.status !== 'ACTIVE') {
      return res.status(403).json({ error: 'Institute is not active' });
    }

    // Update req.user with full user data
    req.user = {
      ...req.user,
      organizationId: hasOrg ? user.organizationId._id : null,
      organization: hasOrg ? user.organizationId : null,
      instituteId: hasInst ? user.instituteId._id : null,
      institute: hasInst ? user.instituteId : null,
      tenantType: hasOrg ? 'ORGANIZATION' : 'INSTITUTE',
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
 * Middleware to ensure user belongs to an Institute (for INSTITUTE_ADMIN, TEACHER, STUDENT)
 * NOTE: Since Organization and Institute are equal level, this checks if user belongs to Institute persona
 */
export const requireInstitute = async (req, res, next) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    // SUPER_ADMIN can access everything
    if (req.user.role === 'SUPER_ADMIN') {
      return next();
    }

    // Load full user document
    const user = await User.findById(req.user._id)
      .populate('organizationId', 'name code status uniqueId')
      .populate('instituteId', 'name code status uniqueId');

    if (!user) {
      return res.status(401).json({ error: 'User not found' });
    }

    // INSTITUTE_ADMIN, TEACHER, STUDENT must belong to an Institute
    if (!user.instituteId) {
      return res.status(403).json({ error: 'User must be assigned to an Institute' });
    }

    // Check institute status
    if (user.instituteId.status !== 'ACTIVE') {
      return res.status(403).json({ error: 'Institute is not active' });
    }

    // Update req.user
    req.user = {
      ...req.user,
      organizationId: null,
      organization: null,
      instituteId: user.instituteId._id,
      institute: user.instituteId,
      tenantType: 'INSTITUTE',
    };

    next();
  } catch (error) {
    return res.status(500).json({ error: 'Institute validation error' });
  }
};

/**
 * Middleware to filter queries by organization/institute boundaries
 * Automatically adds organizationId/instituteId filters to queries
 * NOTE: Organization and Institute are EQUAL LEVEL - user belongs to EITHER one (not both)
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

    // User belongs to EITHER organization OR institute (not both)
    const tenantId = req.user.organizationId || req.user.instituteId;
    const tenantType = req.user.tenantType || (req.user.organizationId ? 'ORGANIZATION' : 'INSTITUTE');

    if (!tenantId) {
      return res.status(403).json({ error: 'User must belong to either an Organization or an Institute' });
    }

    // Build filter based on tenant type
    if (tenantType === 'ORGANIZATION') {
      req.tenantFilter = {
        organizationId: tenantId,
        instituteId: null, // Ensure we only get org-level data
      };
    } else {
      req.tenantFilter = {
        instituteId: tenantId,
        organizationId: null, // Ensure we only get institute-level data
      };
    }

    next();
  } catch (error) {
    return res.status(500).json({ error: 'Tenant boundary enforcement error' });
  }
};

/**
 * Helper function to validate organization/institute access
 * Used in route handlers to ensure users can only access their own tenant data
 * NOTE: Organization and Institute are EQUAL LEVEL - user belongs to EITHER one
 */
export const validateTenantAccess = async (resource, user) => {
  // SUPER_ADMIN can access everything
  if (user.role === 'SUPER_ADMIN') {
    return true;
  }

  // User belongs to EITHER organization OR institute (not both)
  const userTenantId = user.organizationId || user.instituteId;
  const userTenantType = user.tenantType || (user.organizationId ? 'ORGANIZATION' : 'INSTITUTE');

  if (!userTenantId) {
    return false;
  }

  // Resource must belong to the same tenant type and ID
  if (userTenantType === 'ORGANIZATION') {
    const resourceOrgId = resource.organizationId?.toString();
    const userOrgId = userTenantId.toString();
    
    // Resource must belong to this organization AND not belong to any institute
    return resourceOrgId === userOrgId && !resource.instituteId;
  } else {
    const resourceInstId = resource.instituteId?.toString();
    const userInstId = userTenantId.toString();
    
    // Resource must belong to this institute AND not belong to any organization
    return resourceInstId === userInstId && !resource.organizationId;
  }
};
