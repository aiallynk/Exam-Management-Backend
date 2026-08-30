import mongoose from 'mongoose';
import config from '../config/env.js';
import Tenant from '../models/Tenant.js';
import { OrganizationUnit } from '../models/academic/index.js';

// Fixes a real gap the Tenant Admin IA correction introduced: tenants
// created before routes/superAdmin.js's POST /tenants started provisioning
// a root OrganizationUnit alongside the Tenant have no root at all, so
// their Organization Structure page has nothing to show and their Tenant
// Admin cannot add children (see docs/XAMIGO_TENANT_ADMIN_IA_UI_CORRECTION.md).
//
// Purely additive: creates one new OrganizationUnit per Tenant that has
// none, and sets that Tenant's previously-null rootOrganizationUnitId. It
// never modifies or deletes an existing Tenant or OrganizationUnit
// document. Safe by default — no flags means read-only report; --apply
// writes.
//
// Root type is inferred from the existing Tenant.type (SCHOOL/COLLEGE/
// INSTITUTE map directly; COMPANY/GOVERNMENT/OTHER map to OTHER, since
// they have no closer match in OrganizationUnit's root-appropriate types).

const apply = process.argv.includes('--apply');
const TYPE_MAP = { SCHOOL: 'SCHOOL', COLLEGE: 'COLLEGE', INSTITUTE: 'INSTITUTE', COMPANY: 'OTHER', GOVERNMENT: 'OTHER', OTHER: 'OTHER' };

const run = async () => {
  await mongoose.connect(config.mongodbUri, { dbName: 'exam_system' });
  console.log(apply ? 'Running in --apply mode: root OrganizationUnits WILL be created.' : 'Running in dry-run mode (default). Pass --apply to write.');

  const tenants = await Tenant.find({ rootOrganizationUnitId: null }).select('_id name type').lean();
  console.log(`${tenants.length} tenant(s) have no root organization unit.`);

  let created = 0;
  for (const tenant of tenants) {
    const existingRoot = await OrganizationUnit.findOne({ tenantId: tenant._id, parentOrganizationUnitId: null }).select('_id name').lean();
    if (existingRoot) {
      console.log(`  - ${tenant.name}: already has an unlinked root ("${existingRoot.name}") — will only link it, not create a second one.`);
      if (apply) {
        await Tenant.updateOne({ _id: tenant._id }, { $set: { rootOrganizationUnitId: existingRoot._id } });
        created += 1;
      }
      continue;
    }
    const organizationType = TYPE_MAP[tenant.type] || 'OTHER';
    console.log(`  - ${tenant.name} (${tenant.type} -> ${organizationType})`);
    if (apply) {
      const root = await OrganizationUnit.create({
        tenantId: tenant._id, name: tenant.name, type: organizationType, parentOrganizationUnitId: null,
        metadata: { backfilledFromTenant: true },
      });
      await Tenant.updateOne({ _id: tenant._id }, { $set: { rootOrganizationUnitId: root._id } });
      created += 1;
    }
  }

  console.log(`\n${apply ? `Created/linked root organization units for ${created} tenant(s).` : `Would create/link root organization units for ${tenants.length} tenant(s) with --apply.`}`);
  console.log('Rollback note: to undo, delete the created OrganizationUnit documents (metadata.backfilledFromTenant === true) and set the affected Tenant.rootOrganizationUnitId back to null.');
};

run()
  .catch((error) => {
    console.error('Tenant root-organization backfill failed:', error.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect();
  });
