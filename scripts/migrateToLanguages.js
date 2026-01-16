/**
 * Migration Script: Multi-Language Support
 * 
 * This script migrates existing data to support multi-language:
 * 1. Creates default English language if it doesn't exist
 * 2. Sets default language for existing exams
 * 3. Migrates existing question text to default language (en) in translations
 * 
 * Usage: node server/scripts/migrateToLanguages.js
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
import Language from '../models/Language.js';
import Exam from '../models/Exam.js';
import Question from '../models/Question.js';

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/exam-management';

let stats = {
  languages: { created: 0, errors: 0 },
  exams: { processed: 0, updated: 0, errors: 0 },
  questions: { processed: 0, migrated: 0, errors: 0 },
};

async function ensureDefaultLanguage() {
  try {
    let defaultLang = await Language.findOne({ code: 'EN', isDefault: true });
    
    if (!defaultLang) {
      // Check if any language exists
      const anyLang = await Language.findOne({ code: 'EN' });
      if (anyLang) {
        anyLang.isDefault = true;
        await anyLang.save();
        defaultLang = anyLang;
        console.log('  ✓ Set existing EN language as default');
      } else {
        // Create default English language
        defaultLang = new Language({
          code: 'EN',
          name: 'English',
          nativeName: 'English',
          isActive: true,
          isDefault: true,
        });
        await defaultLang.save();
        stats.languages.created++;
        console.log('  ✓ Created default English language');
      }
    } else {
      console.log('  ✓ Default language already exists');
    }
    
    return defaultLang;
  } catch (error) {
    stats.languages.errors++;
    console.error('  ✗ Error ensuring default language:', error.message);
    throw error;
  }
}

async function migrateExam(exam) {
  try {
    let updated = false;

    // Set default language if not set
    if (!exam.defaultLanguage) {
      exam.defaultLanguage = 'en';
      updated = true;
    }

    // Set supported languages if not set
    if (!exam.supportedLanguages || exam.supportedLanguages.length === 0) {
      exam.supportedLanguages = ['en'];
      updated = true;
    }

    if (updated) {
      await exam.save();
      stats.exams.updated++;
    }

    stats.exams.processed++;
  } catch (error) {
    stats.exams.errors++;
    console.error(`  ✗ Error processing Exam ${exam._id}:`, error.message);
  }
}

async function migrateQuestion(question) {
  try {
    // If question has translations, skip
    if (question.translations && question.translations.size > 0) {
      stats.questions.processed++;
      return;
    }

    // Migrate questionText to translations map with 'en' key
    if (question.questionText) {
      if (!question.translations) {
        question.translations = new Map();
      }

      // Add English translation
      question.translations.set('en', {
        questionText: question.questionText,
        options: question.options,
        passage: question.passage || '',
      });

      await question.save();
      stats.questions.migrated++;
    }

    stats.questions.processed++;
  } catch (error) {
    stats.questions.errors++;
    console.error(`  ✗ Error processing Question ${question._id}:`, error.message);
  }
}

async function runMigration() {
  try {
    console.log('Connecting to MongoDB...');
    await mongoose.connect(MONGODB_URI);
    console.log('Connected to MongoDB\n');

    console.log('Starting migration to multi-language support...\n');

    // Step 1: Ensure default language exists
    console.log('Step 1: Ensuring default language exists...');
    await ensureDefaultLanguage();
    console.log('');

    // Step 2: Migrate exams
    console.log('Step 2: Migrating exams...');
    const exams = await Exam.find({});
    console.log(`Found ${exams.length} exams to process`);

    for (const exam of exams) {
      await migrateExam(exam);
    }
    console.log(`  ✓ Processed ${stats.exams.processed} exams, updated ${stats.exams.updated}\n`);

    // Step 3: Migrate questions
    console.log('Step 3: Migrating questions...');
    const questions = await Question.find({});
    console.log(`Found ${questions.length} questions to process`);

    // Process in batches to avoid memory issues
    const batchSize = 100;
    for (let i = 0; i < questions.length; i += batchSize) {
      const batch = questions.slice(i, i + batchSize);
      await Promise.all(batch.map(q => migrateQuestion(q)));
      
      if ((i + batchSize) % 1000 === 0 || i + batchSize >= questions.length) {
        console.log(`  Processed ${Math.min(i + batchSize, questions.length)}/${questions.length} questions...`);
      }
    }
    console.log(`  ✓ Processed ${stats.questions.processed} questions, migrated ${stats.questions.migrated}\n`);

    console.log('=== Migration Summary ===');
    console.log(`Languages created: ${stats.languages.created}`);
    console.log(`Exams processed: ${stats.exams.processed}, updated: ${stats.exams.updated}`);
    console.log(`Questions processed: ${stats.questions.processed}, migrated: ${stats.questions.migrated}`);
    console.log(`Total errors: ${stats.languages.errors + stats.exams.errors + stats.questions.errors}`);

    if (stats.languages.errors + stats.exams.errors + stats.questions.errors === 0) {
      console.log('\n✓ Migration completed successfully!');
    } else {
      console.log('\n⚠ Migration completed with errors. Please review the logs above.');
    }
  } catch (error) {
    console.error('Migration failed:', error);
    process.exit(1);
  } finally {
    await mongoose.disconnect();
    console.log('\nDisconnected from MongoDB');
  }
}

runMigration();
