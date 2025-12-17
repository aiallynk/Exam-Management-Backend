/**
 * Multi-Tenant Middleware
 * Ensures data isolation between organizations and institutes
 */

import User from '../models/User.js';
import Organization from '../models/Organization.js';
import Institute from '../models/Institute.js';

/**
 * Middleware to ensure user has organizationId (except SUPER_ADMIN)
 * Populates req.user with full user document including organization/institute info
 */
export const requireOrganization = async (req, res, next) => {
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
      .populate('organizationId', 'name code status')
      .populate('instituteId', 'name code status organizationId');

    if (!user) {
      return res.status(401).json({ error: 'User not found' });
    }

    // Check if user is active
    if (user.status !== 'ACTIVE') {
      return res.status(403).json({ error: 'Account is not active' });
    }

    // Non-SUPER_ADMIN users must have organizationId
    if (!user.organizationId) {
      return res.status(403).json({ error: 'User must be assigned to an organization' });
    }

    // Check organization status
    if (user.organizationId.status !== 'ACTIVE') {
      return res.status(403).json({ error: 'Organization is not active' });
    }

    // Update req.user with full user data
    req.user = {
      ...req.user,
      organizationId: user.organizationId._id,
      organization: user.organizationId,
      instituteId: user.instituteId?._id || null,
      institute: user.instituteId || null,
    };

    next();
  } catch (error) {
    return res.status(500).json({ error: 'Multi-tenant validation error' });
  }
};

/**
 * Middleware to ensure user has instituteId (for INSTITUTE_ADMIN, TEACHER, STUDENT)
 */
export const requireInstitute = async (req, res, next) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    // SUPER_ADMIN and ORG_ADMIN can access without instituteId
    if (['SUPER_ADMIN', 'ORG_ADMIN'].includes(req.user.role)) {
      return next();
    }

    // Load full user document
    const user = await User.findById(req.user._id)
      .populate('organizationId', 'name code status')
      .populate('instituteId', 'name code status organizationId');

    if (!user) {
      return res.status(401).json({ error: 'User not found' });
    }

    // INSTITUTE_ADMIN, TEACHER, STUDENT must have instituteId
    if (!user.instituteId) {
      return res.status(403).json({ error: 'User must be assigned to an institute' });
    }

    // Check institute status
    if (user.instituteId.status !== 'ACTIVE') {
      return res.status(403).json({ error: 'Institute is not active' });
    }

    // Ensure institute belongs to user's organization
    if (user.organizationId && user.instituteId.organizationId.toString() !== user.organizationId._id.toString()) {
      return res.status(403).json({ error: 'Institute does not belong to your organization' });
    }

    // Update req.user
    req.user = {
      ...req.user,
      organizationId: user.organizationId._id,
      organization: user.organizationId,
      instituteId: user.instituteId._id,
      institute: user.instituteId,
    };

    next();
  } catch (error) {
    return res.status(500).json({ error: 'Institute validation error' });
  }
};

/**
 * Middleware to filter queries by organization/institute boundaries
 * Automatically adds organizationId/instituteId filters to queries
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

    // ORG_ADMIN can see everything in their organization
    if (req.user.role === 'ORG_ADMIN') {
      req.tenantFilter = {
        organizationId: req.user.organizationId || req.user.organization?._id,
      };
      return next();
    }

    // INSTITUTE_ADMIN, TEACHER, STUDENT can only see their institute's data
    req.tenantFilter = {
      organizationId: req.user.organizationId || req.user.organization?._id,
      instituteId: req.user.instituteId || req.user.institute?._id,
    };

    next();
  } catch (error) {
    return res.status(500).json({ error: 'Tenant boundary enforcement error' });
  }
};

/**
 * Helper function to validate organization/institute access
 * Used in route handlers to ensure users can only access their own org/institute data
 */
export const validateTenantAccess = async (resource, user) => {
  // SUPER_ADMIN can access everything
  if (user.role === 'SUPER_ADMIN') {
    return true;
  }

  // Check organization match
  if (resource.organizationId) {
    const resourceOrgId = resource.organizationId.toString();
    const userOrgId = (user.organizationId || user.organization?._id)?.toString();

    if (resourceOrgId !== userOrgId) {
      return false;
    }
  }

  // ORG_ADMIN can access everything in their org
  if (user.role === 'ORG_ADMIN') {
    return true;
  }

  // Check institute match for INSTITUTE_ADMIN, TEACHER, STUDENT
  if (resource.instituteId) {
    const resourceInstId = resource.instituteId.toString();
    const userInstId = (user.instituteId || user.institute?._id)?.toString();

    if (resourceInstId !== userInstId) {
      return false;
    }
  }

  return true;
};
