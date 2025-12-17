/**
 * Create Super Admin Account Script
 * Creates the default Super Admin account: superadmin@aially.in / 111111
 * 
 * Usage: node server/scripts/createSuperAdmin.js
 */

import mongoose from 'mongoose';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load environment variables
dotenv.config({ path: join(__dirname, '../../.env') });

// Import User model
import User from '../models/User.js';

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/exam-management';

const SUPER_ADMIN_EMAIL = 'superadmin@aially.in';
const SUPER_ADMIN_PASSWORD = '111111';
const SUPER_ADMIN_NAME = 'Super Admin';

async function createSuperAdmin() {
  try {
    console.log('🚀 Connecting to MongoDB...');
    console.log(`📦 MongoDB URI: ${MONGODB_URI.replace(/\/\/.*@/, '//***@')}`);
    
    await mongoose.connect(MONGODB_URI);
    console.log('✅ Connected to MongoDB\n');

    // Check if Super Admin already exists
    const existingSuperAdmin = await User.findOne({ 
      $or: [
        { email: SUPER_ADMIN_EMAIL },
        { role: 'SUPER_ADMIN' }
      ]
    });

    if (existingSuperAdmin) {
      if (existingSuperAdmin.email === SUPER_ADMIN_EMAIL) {
        console.log('⚠️  Super Admin account already exists with email:', SUPER_ADMIN_EMAIL);
        console.log('   Updating password...');
        
        // Update password
        existingSuperAdmin.password = SUPER_ADMIN_PASSWORD;
        await existingSuperAdmin.save();
        
        console.log('✅ Super Admin password updated successfully!');
        console.log(`   Email: ${SUPER_ADMIN_EMAIL}`);
        console.log(`   Password: ${SUPER_ADMIN_PASSWORD}`);
      } else {
        console.log('⚠️  A Super Admin account already exists with a different email:', existingSuperAdmin.email);
        console.log('   Skipping creation to avoid conflicts.');
      }
    } else {
      // Create new Super Admin
      console.log('📝 Creating Super Admin account...');
      
      const superAdmin = new User({
        name: SUPER_ADMIN_NAME,
        email: SUPER_ADMIN_EMAIL,
        password: SUPER_ADMIN_PASSWORD,
        role: 'SUPER_ADMIN',
        status: 'ACTIVE',
        // SUPER_ADMIN doesn't need organizationId or instituteId
      });

      await superAdmin.save();
      
      console.log('✅ Super Admin account created successfully!');
      console.log(`   Email: ${SUPER_ADMIN_EMAIL}`);
      console.log(`   Password: ${SUPER_ADMIN_PASSWORD}`);
      console.log(`   Unique ID: ${superAdmin.uniqueId}`);
      console.log(`   Role: ${superAdmin.role}`);
    }

    console.log('\n✅ Script completed successfully!');
    
  } catch (error) {
    console.error('\n❌ Error creating Super Admin:', error);
    process.exit(1);
  } finally {
    await mongoose.disconnect();
    console.log('\n👋 Disconnected from MongoDB');
  }
}

// Run script
createSuperAdmin();
