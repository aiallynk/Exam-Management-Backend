/**
 * Migration Script: Simple 3-Role System
 * 
 * This script migrates the system to the simplified 3-role architecture:
 * - SUPER_ADMIN (unchanged)
 * - EXAM_CREATOR (replaces TENANT_ADMIN, ORG_ADMIN, INSTITUTE_ADMIN, ADMIN, DESIGNER, TEACHER)
 * - CANDIDATE (replaces USER, STUDENT)
 * 
 * Migration Steps:
 * 1. Create Tenant collection from Organization + Institute data
 * 2. Map user roles:
 *    - TENANT_ADMIN, ORG_ADMIN, INSTITUTE_ADMIN, ADMIN, DESIGNER, TEACHER → EXAM_CREATOR
 *    - USER, STUDENT → CANDIDATE
 * 3. Update all organizationId/instituteId → tenantId in Users, Exams, ExamAttempts, ExamSessions, ExamParticipants
 * 4. Remove legacy role fields and education-specific fields
 * 
 * IMPORTANT: Run this script in a test environment first!
 * This script is idempotent - safe to run multiple times.
 */

import mongoose from 'mongoose';
import config from '../config/env.js';
import { connect } from '../utils/db.js';
import User from '../models/User.js';
import Exam from '../models/Exam.js';
import ExamAttempt from '../models/ExamAttempt.js';
import ExamSession from '../models/ExamSession.js';
import ExamParticipant from '../models/ExamParticipant.js';
import Organization from '../models/Organization.js';
import Institute from '../models/Institute.js';
import Tenant from '../models/Tenant.js';

const roleMapping = {
  // Admin/creator roles → EXAM_CREATOR
  'TENANT_ADMIN': 'EXAM_CREATOR',
  'ORG_ADMIN': 'EXAM_CREATOR',
  'INSTITUTE_ADMIN': 'EXAM_CREATOR',
  'ADMIN': 'EXAM_CREATOR',
  'DESIGNER': 'EXAM_CREATOR',
  'TEACHER': 'EXAM_CREATOR',
  
  // User roles → CANDIDATE
  'USER': 'CANDIDATE',
  'STUDENT': 'CANDIDATE',
};

async function createTenantsFromOrganizationsAndInstitutes() {
  console.log('\n📋 Step 1: Creating Tenants from Organizations and Institutes...');
  
  let orgTenantsCreated = 0;
  let instTenantsCreated = 0;
  const tenantMap = new Map(); // Map old org/inst IDs to new tenant IDs
  
  // Migrate Organizations
  console.log('  1a. Migrating Organizations...');
  const organizations = await Organization.find({});
  console.log(`  Found ${organizations.length} organizations`);
  
  for (const org of organizations) {
    // Check if tenant already exists with this code
    let tenant = await Tenant.findOne({ code: org.code });
    
    if (!tenant) {
      tenant = new Tenant({
        name: org.name,
        code: org.code,
        type: 'COMPANY', // Default type for organizations
        contactEmail: org.contactEmail || '',
        contactPhone: org.contactPhone || '',
        address: org.address || '',
        status: org.status || 'ACTIVE',
        examLimit: org.examLimit || null,
        aiUsageLimit: org.aiUsageLimit || null,
        metadata: org.metadata || {},
        createdBy: org.createdBy || new mongoose.Types.ObjectId(), // Use existing or create dummy
      });
      await tenant.save();
      orgTenantsCreated++;
    }
    
    tenantMap.set(`ORG_${org._id.toString()}`, tenant._id);
    console.log(`    ✓ Migrated organization: ${org.name} → Tenant: ${tenant.name}`);
  }
  
  // Migrate Institutes
  console.log('  1b. Migrating Institutes...');
  const institutes = await Institute.find({});
  console.log(`  Found ${institutes.length} institutes`);
  
  for (const inst of institutes) {
    // Check if tenant already exists with this code
    let tenant = await Tenant.findOne({ code: inst.code });
    
    if (!tenant) {
      // Determine type based on institute name or default to INSTITUTE
      let type = 'INSTITUTE';
      const nameLower = inst.name.toLowerCase();
      if (nameLower.includes('school')) type = 'SCHOOL';
      else if (nameLower.includes('college')) type = 'COLLEGE';
      else if (nameLower.includes('university')) type = 'COLLEGE';
      
      tenant = new Tenant({
        name: inst.name,
        code: inst.code,
        type: type,
        contactEmail: inst.contactEmail || '',
        contactPhone: inst.contactPhone || '',
        address: inst.address || '',
        status: inst.status || 'ACTIVE',
        examLimit: inst.examLimit || null,
        aiUsageLimit: inst.aiUsageLimit || null,
        metadata: inst.metadata || {},
        createdBy: inst.createdBy || new mongoose.Types.ObjectId(),
      });
      await tenant.save();
      instTenantsCreated++;
    }
    
    tenantMap.set(`INST_${inst._id.toString()}`, tenant._id);
    console.log(`    ✓ Migrated institute: ${inst.name} → Tenant: ${tenant.name}`);
  }
  
  console.log(`  ✅ Created ${orgTenantsCreated} tenants from organizations`);
  console.log(`  ✅ Created ${instTenantsCreated} tenants from institutes`);
  console.log(`  📊 Total tenant mappings: ${tenantMap.size}`);
  
  return tenantMap;
}

async function migrateUserRoles(tenantMap) {
  console.log('\n📋 Step 2: Migrating user roles...');
  
  let migrated = 0;
  let skipped = 0;
  
  for (const [legacyRole, newRole] of Object.entries(roleMapping)) {
    const users = await User.find({ role: legacyRole });
    console.log(`  Found ${users.length} users with role: ${legacyRole}`);
    
    for (const user of users) {
      // Map role
      user.role = newRole;
      
      // Migrate tenantId
      if (user.organizationId) {
        const tenantId = tenantMap.get(`ORG_${user.organizationId.toString()}`);
        if (tenantId) {
          user.tenantId = tenantId;
          user.organizationId = undefined;
        }
      } else if (user.instituteId) {
        const tenantId = tenantMap.get(`INST_${user.instituteId.toString()}`);
        if (tenantId) {
          user.tenantId = tenantId;
          user.instituteId = undefined;
        }
      }
      
      // Remove education fields
      user.college = undefined;
      user.degree = undefined;
      user.branch = undefined;
      user.hometown = undefined;
      user.canViewResults = undefined;
      user.legacyRole = undefined;
      
      await user.save();
      migrated++;
    }
  }
  
  // Also handle users that might already have universal roles but need tenant migration
  const usersWithTenants = await User.find({
    $or: [{ organizationId: { $exists: true } }, { instituteId: { $exists: true } }]
  });
  
  for (const user of usersWithTenants) {
    if (user.organizationId) {
      const tenantId = tenantMap.get(`ORG_${user.organizationId.toString()}`);
      if (tenantId) {
        user.tenantId = tenantId;
        user.organizationId = undefined;
        await user.save();
      }
    } else if (user.instituteId) {
      const tenantId = tenantMap.get(`INST_${user.instituteId.toString()}`);
      if (tenantId) {
        user.tenantId = tenantId;
        user.instituteId = undefined;
        await user.save();
      }
    }
  }
  
  console.log(`  ✅ Migrated ${migrated} users to new roles`);
  console.log(`  ⏭️  Skipped ${skipped} users (already migrated)`);
}

async function migrateExams(tenantMap) {
  console.log('\n📋 Step 3: Migrating Exams...');
  
  const exams = await Exam.find({
    $or: [{ organizationId: { $exists: true } }, { instituteId: { $exists: true } }]
  });
  console.log(`  Found ${exams.length} exams to migrate`);
  
  let migrated = 0;
  
  for (const exam of exams) {
    if (exam.organizationId) {
      const tenantId = tenantMap.get(`ORG_${exam.organizationId.toString()}`);
      if (tenantId) {
        exam.tenantId = tenantId;
        exam.organizationId = undefined;
        exam.instituteId = undefined;
        await exam.save();
        migrated++;
      }
    } else if (exam.instituteId) {
      const tenantId = tenantMap.get(`INST_${exam.instituteId.toString()}`);
      if (tenantId) {
        exam.tenantId = tenantId;
        exam.organizationId = undefined;
        exam.instituteId = undefined;
        await exam.save();
        migrated++;
      }
    }
  }
  
  console.log(`  ✅ Migrated ${migrated} exams`);
}

async function migrateExamAttempts(tenantMap) {
  console.log('\n📋 Step 4: Migrating Exam Attempts...');
  
  // Get attempts that need migration
  const attempts = await ExamAttempt.find({
    $or: [{ organizationId: { $exists: true } }, { instituteId: { $exists: true } }]
  }).populate('examId', 'organizationId instituteId');
  
  console.log(`  Found ${attempts.length} attempts to migrate`);
  
  let migrated = 0;
  
  for (const attempt of attempts) {
    // Try to get tenantId from exam first
    if (attempt.examId) {
      if (attempt.examId.organizationId) {
        const tenantId = tenantMap.get(`ORG_${attempt.examId.organizationId.toString()}`);
        if (tenantId) {
          attempt.tenantId = tenantId;
          attempt.organizationId = undefined;
          attempt.instituteId = undefined;
          await attempt.save();
          migrated++;
          continue;
        }
      } else if (attempt.examId.instituteId) {
        const tenantId = tenantMap.get(`INST_${attempt.examId.instituteId.toString()}`);
        if (tenantId) {
          attempt.tenantId = tenantId;
          attempt.organizationId = undefined;
          attempt.instituteId = undefined;
          await attempt.save();
          migrated++;
          continue;
        }
      }
    }
    
    // Fallback: use attempt's own org/inst
    if (attempt.organizationId) {
      const tenantId = tenantMap.get(`ORG_${attempt.organizationId.toString()}`);
      if (tenantId) {
        attempt.tenantId = tenantId;
        attempt.organizationId = undefined;
        attempt.instituteId = undefined;
        await attempt.save();
        migrated++;
      }
    } else if (attempt.instituteId) {
      const tenantId = tenantMap.get(`INST_${attempt.instituteId.toString()}`);
      if (tenantId) {
        attempt.tenantId = tenantId;
        attempt.organizationId = undefined;
        attempt.instituteId = undefined;
        await attempt.save();
        migrated++;
      }
    }
  }
  
  console.log(`  ✅ Migrated ${migrated} exam attempts`);
}

async function migrateExamSessions(tenantMap) {
  console.log('\n📋 Step 5: Migrating Exam Sessions...');
  
  const sessions = await ExamSession.find({
    $or: [{ organizationId: { $exists: true } }, { instituteId: { $exists: true } }]
  }).populate('examId', 'organizationId instituteId');
  
  console.log(`  Found ${sessions.length} sessions to migrate`);
  
  let migrated = 0;
  
  for (const session of sessions) {
    // Try to get tenantId from exam first
    if (session.examId) {
      if (session.examId.organizationId) {
        const tenantId = tenantMap.get(`ORG_${session.examId.organizationId.toString()}`);
        if (tenantId) {
          session.tenantId = tenantId;
          session.organizationId = undefined;
          session.instituteId = undefined;
          await session.save();
          migrated++;
          continue;
        }
      } else if (session.examId.instituteId) {
        const tenantId = tenantMap.get(`INST_${session.examId.instituteId.toString()}`);
        if (tenantId) {
          session.tenantId = tenantId;
          session.organizationId = undefined;
          session.instituteId = undefined;
          await session.save();
          migrated++;
          continue;
        }
      }
    }
    
    // Fallback: use session's own org/inst
    if (session.organizationId) {
      const tenantId = tenantMap.get(`ORG_${session.organizationId.toString()}`);
      if (tenantId) {
        session.tenantId = tenantId;
        session.organizationId = undefined;
        session.instituteId = undefined;
        await session.save();
        migrated++;
      }
    } else if (session.instituteId) {
      const tenantId = tenantMap.get(`INST_${session.instituteId.toString()}`);
      if (tenantId) {
        session.tenantId = tenantId;
        session.organizationId = undefined;
        session.instituteId = undefined;
        await session.save();
        migrated++;
      }
    }
  }
  
  console.log(`  ✅ Migrated ${migrated} exam sessions`);
}

async function migrateExamParticipants(tenantMap) {
  console.log('\n📋 Step 6: Migrating Exam Participants...');
  
  const participants = await ExamParticipant.find({
    $or: [{ organizationId: { $exists: true } }, { instituteId: { $exists: true } }]
  }).populate('examId', 'organizationId instituteId');
  
  console.log(`  Found ${participants.length} participants to migrate`);
  
  let migrated = 0;
  
  for (const participant of participants) {
    // Try to get tenantId from exam first
    if (participant.examId) {
      if (participant.examId.organizationId) {
        const tenantId = tenantMap.get(`ORG_${participant.examId.organizationId.toString()}`);
        if (tenantId) {
          participant.tenantId = tenantId;
          participant.organizationId = undefined;
          participant.instituteId = undefined;
          await participant.save();
          migrated++;
          continue;
        }
      } else if (participant.examId.instituteId) {
        const tenantId = tenantMap.get(`INST_${participant.examId.instituteId.toString()}`);
        if (tenantId) {
          participant.tenantId = tenantId;
          participant.organizationId = undefined;
          participant.instituteId = undefined;
          await participant.save();
          migrated++;
          continue;
        }
      }
    }
    
    // Fallback: use participant's own org/inst
    if (participant.organizationId) {
      const tenantId = tenantMap.get(`ORG_${participant.organizationId.toString()}`);
      if (tenantId) {
        participant.tenantId = tenantId;
        participant.organizationId = undefined;
        participant.instituteId = undefined;
        await participant.save();
        migrated++;
      }
    } else if (participant.instituteId) {
      const tenantId = tenantMap.get(`INST_${participant.instituteId.toString()}`);
      if (tenantId) {
        participant.tenantId = tenantId;
        participant.organizationId = undefined;
        participant.instituteId = undefined;
        await participant.save();
        migrated++;
      }
    }
  }
  
  console.log(`  ✅ Migrated ${migrated} exam participants`);
}

async function main() {
  try {
    console.log('🚀 Starting migration to Simple 3-Role System...\n');
    console.log('⚠️  WARNING: This will modify your database!');
    console.log('⚠️  Make sure you have a backup before proceeding.\n');
    
    // Connect to database
    await connect();
    console.log('✅ Connected to database\n');
    
    // Step 1: Create Tenants
    const tenantMap = await createTenantsFromOrganizationsAndInstitutes();
    
    // Step 2: Migrate User Roles
    await migrateUserRoles(tenantMap);
    
    // Step 3: Migrate Exams
    await migrateExams(tenantMap);
    
    // Step 4: Migrate Exam Attempts
    await migrateExamAttempts(tenantMap);
    
    // Step 5: Migrate Exam Sessions
    await migrateExamSessions(tenantMap);
    
    // Step 6: Migrate Exam Participants
    await migrateExamParticipants(tenantMap);
    
    console.log('\n✅ Migration completed successfully!');
    console.log('\n📝 Next steps:');
    console.log('  1. Verify the migration by checking a few records');
    console.log('  2. Test the application thoroughly');
    console.log('  3. Once verified, you can delete Organization and Institute models');
    console.log('  4. Update any remaining references in code');
    
  } catch (error) {
    console.error('\n❌ Migration failed:', error);
    throw error;
  } finally {
    await mongoose.connection.close();
    console.log('\n🔌 Database connection closed');
  }
}

// Run migration if executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error('Fatal error:', error);
    process.exit(1);
  });
}

export default main;
