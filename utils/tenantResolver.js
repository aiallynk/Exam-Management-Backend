import mongoose from 'mongoose';
import Tenant from '../models/Tenant.js';

const normalizeTenantId = (tenantId) => {
  if (!tenantId) return null;
  if (typeof tenantId === 'object' && tenantId._id) {
    return tenantId._id;
  }
  return tenantId;
};

export const resolveTenantSnapshot = async (
  tenantId,
  select = 'name code status uniqueId type'
) => {
  const normalizedTenantId = normalizeTenantId(tenantId);
  if (!normalizedTenantId || !mongoose.isValidObjectId(normalizedTenantId)) {
    return null;
  }

  return Tenant.findById(normalizedTenantId).select(select).lean();
};

