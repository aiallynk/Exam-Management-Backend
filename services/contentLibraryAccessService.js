import { resolveAcademicVisibility } from './academicAccessService.js';
import {
  expandOrganizationUnitAncestors,
  resolveAuthorizedOrganizationUnits,
} from './organizationContextService.js';

const uniqueIds = (values = []) => [...new Set(values.filter(Boolean).map(String))];

// Content Library is the one academic surface where a published
// institution-level resource is intentionally consumable by an eligible
// Exam Creator even when that person has not yet been attached to a specific
// CourseOffering. Reuse the existing organization-membership model rather
// than adding a second content ACL. All non-organization academic dimensions
// still come from resolveAcademicVisibility and every caller remains tenant
// bound by the authenticated user's tenant.
export const resolveContentLibraryVisibility = async (user) => {
  const academic = await resolveAcademicVisibility(user);
  if (academic.all) return academic;

  const organization = await resolveAuthorizedOrganizationUnits(user);
  const directUnitIds = uniqueIds([
    ...(academic.ids?.['organization-units'] || []),
    ...(organization.unitIds || []),
  ]);
  const readableUnitIds = await expandOrganizationUnitAncestors(academic.tenantId, directUnitIds);

  return {
    ...academic,
    ids: {
      ...(academic.ids || {}),
      'organization-units': readableUnitIds,
    },
  };
};
