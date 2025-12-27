/**
 * Migration Script: Universal Role System
 * 
 * This script migrates the system from education-biased roles to universal exam platform roles.
 * 
 * Migration Steps:
 * 1. Map legacy user roles to universal roles:
 *    - ORG_ADMIN → TENANT_ADMIN
 *    - INSTITUTE_ADMIN → TENANT_ADMIN
 *    - ADMIN → TENANT_ADMIN
 *    - TEACHER → USER
 *    - STUDENT → USER
 *    - DESIGNER → USER
 * 
 * 2. Create ExamParticipant records:
 *    - For each Exam: create CREATOR entry for exam.createdBy
 *    - For each ExamAttempt: create CANDIDATE entry if not exists
 * 
 * 3. Update SystemConfig keys:
 *    - blocked_student_* → blocked_user_*
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
import ExamParticipant from '../models/ExamParticipant.js';
import SystemConfig from '../models/SystemConfig.js';

const roleMapping = {
  // Legacy admin roles → TENANT_ADMIN
  'ORG_ADMIN': 'TENANT_ADMIN',
  'INSTITUTE_ADMIN': 'TENANT_ADMIN',
  'ADMIN': 'TENANT_ADMIN',
  
  // Legacy education roles → USER
  'TEACHER': 'USER',
  'STUDENT': 'USER',
  'DESIGNER': 'USER',
};

async function migrateUserRoles() {
  console.log('\n📋 Step 1: Migrating user roles...');
  
  let migrated = 0;
  let skipped = 0;
  
  for (const [legacyRole, universalRole] of Object.entries(roleMapping)) {
    const users = await User.find({ role: legacyRole });
    console.log(`  Found ${users.length} users with role: ${legacyRole}`);
    
    for (const user of users) {
      // Store legacy role if not already stored
      if (!user.legacyRole) {
        user.legacyRole = legacyRole;
      }
      
      // Map to universal role
      user.role = universalRole;
      await user.save();
      migrated++;
    }
    
    skipped += users.length - migrated;
  }
  
  console.log(`  ✅ Migrated ${migrated} users to universal roles`);
  console.log(`  ⏭️  Skipped ${skipped} users (already migrated)`);
}

async function createExamParticipantRecords() {
  console.log('\n📋 Step 2: Creating ExamParticipant records...');
  
  // 2a. Create CREATOR records for exam creators
  console.log('  2a. Creating CREATOR records for exam creators...');
  const exams = await Exam.find({}).select('_id createdBy organizationId instituteId');
  let creatorCount = 0;
  let creatorSkipped = 0;
  
  for (const exam of exams) {
    if (!exam.createdBy) continue;
    
    // Check if ExamParticipant already exists
    const existing = await ExamParticipant.findOne({
      examId: exam._id,
      userId: exam.createdBy,
      examRole: 'CREATOR',
    });
    
    if (existing) {
      creatorSkipped++;
      continue;
    }
    
    // Create CREATOR record
    try {
      await ExamParticipant.create({
        examId: exam._id,
        userId: exam.createdBy,
        examRole: 'CREATOR',
        assignedBy: exam.createdBy,
        organizationId: exam.organizationId || null,
        instituteId: exam.instituteId || null,
      });
      creatorCount++;
    } catch (error) {
      console.error(`    ⚠️  Error creating CREATOR for exam ${exam._id}:`, error.message);
    }
  }
  
  console.log(`    ✅ Created ${creatorCount} CREATOR records`);
  console.log(`    ⏭️  Skipped ${creatorSkipped} (already exist)`);
  
  // 2b. Create CANDIDATE records for exam attempts
  console.log('  2b. Creating CANDIDATE records for exam attempts...');
  const attempts = await ExamAttempt.find({})
    .select('_id examId userId')
    .populate('examId', 'organizationId instituteId');
  
  let candidateCount = 0;
  let candidateSkipped = 0;
  const processedPairs = new Set(); // Track (examId, userId) pairs to avoid duplicates
  
  for (const attempt of attempts) {
    if (!attempt.examId || !attempt.userId) continue;
    
    const pairKey = `${attempt.examId._id}_${attempt.userId}`;
    if (processedPairs.has(pairKey)) {
      candidateSkipped++;
      continue;
    }
    processedPairs.add(pairKey);
    
    // Check if ExamParticipant already exists
    const existing = await ExamParticipant.findOne({
      examId: attempt.examId._id,
      userId: attempt.userId,
      examRole: 'CANDIDATE',
    });
    
    if (existing) {
      candidateSkipped++;
      continue;
    }
    
    // Create CANDIDATE record
    try {
      await ExamParticipant.create({
        examId: attempt.examId._id,
        userId: attempt.userId,
        examRole: 'CANDIDATE',
        assignedBy: attempt.userId, // Self-assigned when attempting
        organizationId: attempt.examId.organizationId || null,
        instituteId: attempt.examId.instituteId || null,
      });
      candidateCount++;
    } catch (error) {
      console.error(`    ⚠️  Error creating CANDIDATE for attempt ${attempt._id}:`, error.message);
    }
  }
  
  console.log(`    ✅ Created ${candidateCount} CANDIDATE records`);
  console.log(`    ⏭️  Skipped ${candidateSkipped} (already exist or duplicates)`);
}

async function migrateSystemConfigKeys() {
  console.log('\n📋 Step 3: Migrating SystemConfig keys (blocked_student_ → blocked_user_)...');
  
  const blockedConfigs = await SystemConfig.find({
    key: { $regex: /^blocked_student_/ },
  });
  
  let migrated = 0;
  let skipped = 0;
  
  for (const config of blockedConfigs) {
    // Extract user ID from old key
    const userId = config.key.replace('blocked_student_', '');
    const newKey = `blocked_user_${userId}`;
    
    // Check if new key already exists
    const existing = await SystemConfig.findOne({ key: newKey });
    if (existing) {
      // New key exists, delete old one
      await SystemConfig.deleteOne({ _id: config._id });
      skipped++;
      continue;
    }
    
    // Update to new key
    config.key = newKey;
    config.description = config.description?.replace('student', 'user') || `Block status for user`;
    await config.save();
    migrated++;
  }
  
  console.log(`  ✅ Migrated ${migrated} SystemConfig keys`);
  console.log(`  ⏭️  Skipped ${skipped} (new key already exists)`);
}

async function runMigration() {
  try {
    console.log('🚀 Starting Universal Role System Migration...\n');
    console.log('⚠️  WARNING: This will modify user roles and create ExamParticipant records.');
    console.log('⚠️  Make sure you have a database backup!\n');
    
    await connect();
    console.log('✅ Connected to database\n');
    
    // Step 1: Migrate user roles
    await migrateUserRoles();
    
    // Step 2: Create ExamParticipant records
    await createExamParticipantRecords();
    
    // Step 3: Migrate SystemConfig keys
    await migrateSystemConfigKeys();
    
    console.log('\n✅ Migration completed successfully!');
    console.log('\n📊 Summary:');
    console.log('  - User roles migrated to universal system');
    console.log('  - ExamParticipant records created');
    console.log('  - SystemConfig keys updated');
    console.log('\n💡 Next steps:');
    console.log('  1. Test the application thoroughly');
    console.log('  2. Verify ExamParticipant records are correct');
    console.log('  3. Check that all users can access their exams');
    
    process.exit(0);
  } catch (error) {
    console.error('\n❌ Migration failed:', error);
    process.exit(1);
  }
}

// Run migration if script is executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  runMigration();
}

export default runMigration;

