/**
 * Migration Script: Audit Logs Collection
 * 
 * This script ensures the AuditLog collection exists and is properly indexed.
 * Since audit logs are written in real-time, this script mainly:
 * 1. Creates the collection if it doesn't exist
 * 2. Ensures indexes are created
 * 
 * Usage: node server/scripts/migrateAuditLogs.js
 */

import mongoose from 'mongoose';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load environment variables
dotenv.config({ path: join(__dirname, '../../.env') });

// Import model
import AuditLog from '../models/AuditLog.js';

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/exam-management';

async function runMigration() {
  try {
    console.log('Connecting to MongoDB...');
    await mongoose.connect(MONGODB_URI);
    console.log('Connected to MongoDB\n');

    console.log('Initializing AuditLog collection...\n');

    // Create collection if it doesn't exist (Mongoose does this automatically, but we ensure indexes)
    const collection = mongoose.connection.collection('auditlogs');
    
    // Check if collection exists
    const collections = await mongoose.connection.db.listCollections({ name: 'auditlogs' }).toArray();
    if (collections.length === 0) {
      console.log('  Creating AuditLog collection...');
    } else {
      console.log('  AuditLog collection already exists');
    }

    // Ensure indexes are created
    console.log('  Creating indexes...');
    await AuditLog.createIndexes();
    console.log('  ✓ Indexes created/verified');

    // Get collection stats
    const stats = await collection.stats();
    console.log(`\n  Collection stats:`);
    console.log(`    Documents: ${stats.count}`);
    console.log(`    Size: ${(stats.size / 1024 / 1024).toFixed(2)} MB`);
    console.log(`    Indexes: ${stats.nindexes}`);

    console.log('\n✓ AuditLog collection ready!');
    console.log('\nNote: Audit logs will be written automatically when actions occur.');
    console.log('No historical data migration needed as logs are written in real-time.');
  } catch (error) {
    console.error('Migration failed:', error);
    process.exit(1);
  } finally {
    await mongoose.disconnect();
    console.log('\nDisconnected from MongoDB');
  }
}

runMigration();
