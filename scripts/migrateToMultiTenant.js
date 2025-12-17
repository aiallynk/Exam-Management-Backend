/**
 * Migration Script: Multi-Tenant Architecture & Unique IDs
 * 
 * This script migrates existing data to the new multi-tenant architecture:
 * 1. Generates uniqueId for all entities
 * 2. Ensures users belong to EITHER Organization OR Institute (not both)
 * 3. Ensures exams belong to EITHER Organization OR Institute (not both)
 * 4. Updates tenant IDs for sessions and attempts
 * 
 * Usage: node server/scripts/migrateToMultiTenant.js
 */

import mongoose from 'mongoose';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load environment variables
dotenv.config({ path: join(__dirname, '../../.env') });

// Import models
import User from '../models/User.js';
import Organization from '../models/Organization.js';
import Institute from '../models/Institute.js';
import Exam from '../models/Exam.js';
import ExamSession from '../models/ExamSession.js';
import ExamAttempt from '../models/ExamAttempt.js';
import Question from '../models/Question.js';
import QuestionPaper from '../models/QuestionPaper.js';
import { generateUniqueIdWithCheck, ID_PREFIXES } from '../utils/idGenerator.js';

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/exam-management';

let stats = {
  users: { processed: 0, errors: 0, uniqueIdsGenerated: 0 },
  organizations: { processed: 0, errors: 0, uniqueIdsGenerated: 0 },
  institutes: { processed: 0, errors: 0, uniqueIdsGenerated: 0 },
  exams: { processed: 0, errors: 0, uniqueIdsGenerated: 0, tenantFixed: 0 },
  sessions: { processed: 0, errors: 0, uniqueIdsGenerated: 0, tenantFixed: 0 },
  attempts: { processed: 0, errors: 0, uniqueIdsGenerated: 0, tenantFixed: 0 },
  questions: { processed: 0, errors: 0, uniqueIdsGenerated: 0 },
  questionPapers: { processed: 0, errors: 0, uniqueIdsGenerated: 0 },
};

async function generateUniqueIdForEntity(Model, entity, prefix) {
  if (!entity.uniqueId) {
    try {
      entity.uniqueId = await generateUniqueIdWithCheck(Model, prefix);
      await entity.save();
      return true;
    } catch (error) {
      console.error(`Error generating uniqueId for ${Model.modelName} ${entity._id}:`, error.message);
      return false;
    }
  }
  return false;
}

async function migrateOrganizations() {
  console.log('\n📋 Migrating Organizations...');
  const orgs = await Organization.find({});
  
  for (const org of orgs) {
    try {
      const generated = await generateUniqueIdForEntity(Organization, org, ID_PREFIXES.ORGANIZATION);
      if (generated) stats.organizations.uniqueIdsGenerated++;
      stats.organizations.processed++;
    } catch (error) {
      console.error(`Error processing organization ${org._id}:`, error.message);
      stats.organizations.errors++;
    }
  }
  
  console.log(`✅ Organizations: ${stats.organizations.processed} processed, ${stats.organizations.uniqueIdsGenerated} uniqueIds generated`);
}

async function migrateInstitutes() {
  console.log('\n📋 Migrating Institutes...');
  const insts = await Institute.find({});
  
  for (const inst of insts) {
    try {
      const generated = await generateUniqueIdForEntity(Institute, inst, ID_PREFIXES.INSTITUTE);
      if (generated) stats.institutes.uniqueIdsGenerated++;
      stats.institutes.processed++;
    } catch (error) {
      console.error(`Error processing institute ${inst._id}:`, error.message);
      stats.institutes.errors++;
    }
  }
  
  console.log(`✅ Institutes: ${stats.institutes.processed} processed, ${stats.institutes.uniqueIdsGenerated} uniqueIds generated`);
}

async function migrateUsers() {
  console.log('\n📋 Migrating Users...');
  const users = await User.find({});
  
  for (const user of users) {
    try {
      // Generate uniqueId
      const generated = await generateUniqueIdForEntity(User, user, ID_PREFIXES.USER);
      if (generated) stats.users.uniqueIdsGenerated++;
      
      // Fix tenant assignment: User must belong to EITHER Organization OR Institute (not both)
      if (user.role !== 'SUPER_ADMIN') {
        const hasOrg = !!user.organizationId;
        const hasInst = !!user.instituteId;
        
        if (hasOrg && hasInst) {
          // User has both - keep based on role
          if (user.role === 'ORG_ADMIN') {
            // Keep organization, remove institute
            user.instituteId = null;
            await user.save();
            console.log(`  ⚠️  User ${user._id} (${user.role}) had both org and inst. Removed institute.`);
          } else {
            // Keep institute, remove organization
            user.organizationId = null;
            await user.save();
            console.log(`  ⚠️  User ${user._id} (${user.role}) had both org and inst. Removed organization.`);
          }
        } else if (!hasOrg && !hasInst) {
          console.log(`  ⚠️  User ${user._id} (${user.role}) has no tenant assigned. Skipping...`);
        }
      }
      
      stats.users.processed++;
    } catch (error) {
      console.error(`Error processing user ${user._id}:`, error.message);
      stats.users.errors++;
    }
  }
  
  console.log(`✅ Users: ${stats.users.processed} processed, ${stats.users.uniqueIdsGenerated} uniqueIds generated`);
}

async function migrateExams() {
  console.log('\n📋 Migrating Exams...');
  const exams = await Exam.find({}).populate('createdBy');
  
  for (const exam of exams) {
    try {
      // Generate uniqueId
      const generated = await generateUniqueIdForEntity(Exam, exam, ID_PREFIXES.EXAM);
      if (generated) stats.exams.uniqueIdsGenerated++;
      
      // Fix tenant assignment: Exam must belong to EITHER Organization OR Institute (not both)
      const hasOrg = !!exam.organizationId;
      const hasInst = !!exam.instituteId;
      
      if (hasOrg && hasInst) {
        // Exam has both - inherit from creator
        if (exam.createdBy) {
          if (exam.createdBy.organizationId) {
            exam.instituteId = null;
            await exam.save();
            stats.exams.tenantFixed++;
            console.log(`  ⚠️  Exam ${exam._id} had both org and inst. Fixed based on creator.`);
          } else if (exam.createdBy.instituteId) {
            exam.organizationId = null;
            await exam.save();
            stats.exams.tenantFixed++;
            console.log(`  ⚠️  Exam ${exam._id} had both org and inst. Fixed based on creator.`);
          }
        }
      } else if (!hasOrg && !hasInst && exam.createdBy) {
        // Exam has no tenant - inherit from creator
        if (exam.createdBy.organizationId) {
          exam.organizationId = exam.createdBy.organizationId;
          await exam.save();
          stats.exams.tenantFixed++;
        } else if (exam.createdBy.instituteId) {
          exam.instituteId = exam.createdBy.instituteId;
          await exam.save();
          stats.exams.tenantFixed++;
        }
      }
      
      stats.exams.processed++;
    } catch (error) {
      console.error(`Error processing exam ${exam._id}:`, error.message);
      stats.exams.errors++;
    }
  }
  
  console.log(`✅ Exams: ${stats.exams.processed} processed, ${stats.exams.uniqueIdsGenerated} uniqueIds generated, ${stats.exams.tenantFixed} tenant assignments fixed`);
}

async function migrateSessions() {
  console.log('\n📋 Migrating Exam Sessions...');
  const sessions = await ExamSession.find({}).populate('examId');
  
  for (const session of sessions) {
    try {
      // Generate uniqueId
      const generated = await generateUniqueIdForEntity(ExamSession, session, ID_PREFIXES.SESSION);
      if (generated) stats.sessions.uniqueIdsGenerated++;
      
      // Inherit tenant from exam
      if (session.examId) {
        const needsUpdate = 
          session.organizationId?.toString() !== session.examId.organizationId?.toString() ||
          session.instituteId?.toString() !== session.examId.instituteId?.toString();
        
        if (needsUpdate) {
          session.organizationId = session.examId.organizationId || null;
          session.instituteId = session.examId.instituteId || null;
          await session.save();
          stats.sessions.tenantFixed++;
        }
      }
      
      stats.sessions.processed++;
    } catch (error) {
      console.error(`Error processing session ${session._id}:`, error.message);
      stats.sessions.errors++;
    }
  }
  
  console.log(`✅ Sessions: ${stats.sessions.processed} processed, ${stats.sessions.uniqueIdsGenerated} uniqueIds generated, ${stats.sessions.tenantFixed} tenant assignments fixed`);
}

async function migrateAttempts() {
  console.log('\n📋 Migrating Exam Attempts...');
  const attempts = await ExamAttempt.find({}).populate('examId');
  
  for (const attempt of attempts) {
    try {
      // Generate uniqueId
      const generated = await generateUniqueIdForEntity(ExamAttempt, attempt, ID_PREFIXES.ATTEMPT);
      if (generated) stats.attempts.uniqueIdsGenerated++;
      
      // Inherit tenant from exam
      if (attempt.examId) {
        const needsUpdate = 
          attempt.organizationId?.toString() !== attempt.examId.organizationId?.toString() ||
          attempt.instituteId?.toString() !== attempt.examId.instituteId?.toString();
        
        if (needsUpdate) {
          attempt.organizationId = attempt.examId.organizationId || null;
          attempt.instituteId = attempt.examId.instituteId || null;
          await attempt.save();
          stats.attempts.tenantFixed++;
        }
      }
      
      stats.attempts.processed++;
    } catch (error) {
      console.error(`Error processing attempt ${attempt._id}:`, error.message);
      stats.attempts.errors++;
    }
  }
  
  console.log(`✅ Attempts: ${stats.attempts.processed} processed, ${stats.attempts.uniqueIdsGenerated} uniqueIds generated, ${stats.attempts.tenantFixed} tenant assignments fixed`);
}

async function migrateQuestions() {
  console.log('\n📋 Migrating Questions...');
  const questions = await Question.find({});
  
  for (const question of questions) {
    try {
      const generated = await generateUniqueIdForEntity(Question, question, ID_PREFIXES.QUESTION);
      if (generated) stats.questions.uniqueIdsGenerated++;
      stats.questions.processed++;
    } catch (error) {
      console.error(`Error processing question ${question._id}:`, error.message);
      stats.questions.errors++;
    }
  }
  
  console.log(`✅ Questions: ${stats.questions.processed} processed, ${stats.questions.uniqueIdsGenerated} uniqueIds generated`);
}

async function migrateQuestionPapers() {
  console.log('\n📋 Migrating Question Papers...');
  const papers = await QuestionPaper.find({});
  
  for (const paper of papers) {
    try {
      const generated = await generateUniqueIdForEntity(QuestionPaper, paper, ID_PREFIXES.QUESTION_PAPER);
      if (generated) stats.questionPapers.uniqueIdsGenerated++;
      stats.questionPapers.processed++;
    } catch (error) {
      console.error(`Error processing question paper ${paper._id}:`, error.message);
      stats.questionPapers.errors++;
    }
  }
  
  console.log(`✅ Question Papers: ${stats.questionPapers.processed} processed, ${stats.questionPapers.uniqueIdsGenerated} uniqueIds generated`);
}

async function runMigration() {
  try {
    console.log('🚀 Starting Multi-Tenant Migration...');
    console.log(`📦 Connecting to MongoDB: ${MONGODB_URI.replace(/\/\/.*@/, '//***@')}`);
    
    await mongoose.connect(MONGODB_URI);
    console.log('✅ Connected to MongoDB\n');
    
    // Run migrations in order
    await migrateOrganizations();
    await migrateInstitutes();
    await migrateUsers();
    await migrateExams();
    await migrateSessions();
    await migrateAttempts();
    await migrateQuestions();
    await migrateQuestionPapers();
    
    // Print summary
    console.log('\n' + '='.repeat(60));
    console.log('📊 Migration Summary');
    console.log('='.repeat(60));
    console.log(`Organizations: ${stats.organizations.processed} processed, ${stats.organizations.uniqueIdsGenerated} uniqueIds, ${stats.organizations.errors} errors`);
    console.log(`Institutes: ${stats.institutes.processed} processed, ${stats.institutes.uniqueIdsGenerated} uniqueIds, ${stats.institutes.errors} errors`);
    console.log(`Users: ${stats.users.processed} processed, ${stats.users.uniqueIdsGenerated} uniqueIds, ${stats.users.errors} errors`);
    console.log(`Exams: ${stats.exams.processed} processed, ${stats.exams.uniqueIdsGenerated} uniqueIds, ${stats.exams.tenantFixed} tenant fixes, ${stats.exams.errors} errors`);
    console.log(`Sessions: ${stats.sessions.processed} processed, ${stats.sessions.uniqueIdsGenerated} uniqueIds, ${stats.sessions.tenantFixed} tenant fixes, ${stats.sessions.errors} errors`);
    console.log(`Attempts: ${stats.attempts.processed} processed, ${stats.attempts.uniqueIdsGenerated} uniqueIds, ${stats.attempts.tenantFixed} tenant fixes, ${stats.attempts.errors} errors`);
    console.log(`Questions: ${stats.questions.processed} processed, ${stats.questions.uniqueIdsGenerated} uniqueIds, ${stats.questions.errors} errors`);
    console.log(`Question Papers: ${stats.questionPapers.processed} processed, ${stats.questionPapers.uniqueIdsGenerated} uniqueIds, ${stats.questionPapers.errors} errors`);
    console.log('='.repeat(60));
    
    console.log('\n✅ Migration completed successfully!');
    
  } catch (error) {
    console.error('\n❌ Migration failed:', error);
    process.exit(1);
  } finally {
    await mongoose.disconnect();
    console.log('\n👋 Disconnected from MongoDB');
  }
}

// Run migration
runMigration();
