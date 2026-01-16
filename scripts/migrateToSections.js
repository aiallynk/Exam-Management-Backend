/**
 * Migration Script: Sections Support
 * 
 * This script migrates existing data to support sections:
 * 1. Creates default sections for existing QuestionPapers
 * 2. Assigns existing questions to default sections
 * 
 * Usage: node server/scripts/migrateToSections.js
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
import QuestionPaper from '../models/QuestionPaper.js';
import Question from '../models/Question.js';
import Section from '../models/Section.js';

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/exam-management';

let stats = {
  questionPapers: { processed: 0, sectionsCreated: 0, errors: 0 },
  questions: { processed: 0, assigned: 0, errors: 0 },
};

async function migrateQuestionPaper(questionPaper) {
  try {
    // Check if sections already exist
    const existingSections = await Section.find({ questionPaperId: questionPaper._id });
    if (existingSections.length > 0) {
      console.log(`  QuestionPaper ${questionPaper._id} already has sections, skipping...`);
      return;
    }

    // Create default section
    const defaultSection = new Section({
      questionPaperId: questionPaper._id,
      name: 'Default Section',
      description: 'Default section created during migration',
      order: 0,
      duration: 60, // Default 60 minutes
      marks: 0,
      negativeMarking: 0,
      navigationRule: 'FREE',
      instructions: '',
      isActive: true,
    });

    await defaultSection.save();
    stats.questionPapers.sectionsCreated++;

    // Update QuestionPaper with section reference
    questionPaper.sections = [defaultSection._id];
    await questionPaper.save();

    // Assign all questions in this paper to the default section
    const questions = await Question.find({ questionPaperId: questionPaper._id });
    for (const question of questions) {
      if (!question.sectionId) {
        question.sectionId = defaultSection._id;
        await question.save();
        stats.questions.assigned++;
      }
    }

    stats.questionPapers.processed++;
    console.log(`  ✓ Created default section for QuestionPaper ${questionPaper._id}`);
  } catch (error) {
    stats.questionPapers.errors++;
    console.error(`  ✗ Error processing QuestionPaper ${questionPaper._id}:`, error.message);
  }
}

async function runMigration() {
  try {
    console.log('Connecting to MongoDB...');
    await mongoose.connect(MONGODB_URI);
    console.log('Connected to MongoDB\n');

    console.log('Starting migration to sections...\n');

    // Get all QuestionPapers
    const questionPapers = await QuestionPaper.find({});
    console.log(`Found ${questionPapers.length} QuestionPapers to process\n`);

    for (const questionPaper of questionPapers) {
      console.log(`Processing QuestionPaper: ${questionPaper.setName} (${questionPaper._id})`);
      await migrateQuestionPaper(questionPaper);
    }

    // Get total questions count
    const totalQuestions = await Question.countDocuments({});
    stats.questions.processed = totalQuestions;

    console.log('\n=== Migration Summary ===');
    console.log(`QuestionPapers processed: ${stats.questionPapers.processed}`);
    console.log(`Sections created: ${stats.questionPapers.sectionsCreated}`);
    console.log(`Questions processed: ${stats.questions.processed}`);
    console.log(`Questions assigned to sections: ${stats.questions.assigned}`);
    console.log(`Errors: ${stats.questionPapers.errors + stats.questions.errors}`);

    if (stats.questionPapers.errors + stats.questions.errors === 0) {
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
