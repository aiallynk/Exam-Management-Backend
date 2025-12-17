import mongoose from 'mongoose';
import config from '../config/env.js';
import User from '../models/User.js';

export const connect = async () => {
  try {
    await mongoose.connect(config.mongodbUri, {
      dbName: 'exam_system',
    });
    console.log('✅ MongoDB connected successfully');
    
    // Auto-create Super Admin account if it doesn't exist
    await ensureSuperAdmin();
  } catch (error) {
    console.error('❌ MongoDB connection error:', error);
    process.exit(1);
  }
};

/**
 * Ensure Super Admin account exists
 * Creates superadmin@aially.in with password 111111 if it doesn't exist
 */
async function ensureSuperAdmin() {
  try {
    const SUPER_ADMIN_EMAIL = 'superadmin@aially.in';
    const SUPER_ADMIN_PASSWORD = '111111';
    const SUPER_ADMIN_NAME = 'Super Admin';

    const existingSuperAdmin = await User.findOne({ 
      email: SUPER_ADMIN_EMAIL
    });

    if (existingSuperAdmin) {
      // Update password to ensure it's correct
      if (existingSuperAdmin.role !== 'SUPER_ADMIN') {
        existingSuperAdmin.role = 'SUPER_ADMIN';
      }
      existingSuperAdmin.password = SUPER_ADMIN_PASSWORD;
      existingSuperAdmin.status = 'ACTIVE';
      await existingSuperAdmin.save();
      console.log('✅ Super Admin account verified:', SUPER_ADMIN_EMAIL);
    } else {
      // Create new Super Admin
      const superAdmin = new User({
        name: SUPER_ADMIN_NAME,
        email: SUPER_ADMIN_EMAIL,
        password: SUPER_ADMIN_PASSWORD,
        role: 'SUPER_ADMIN',
        status: 'ACTIVE',
        // SUPER_ADMIN doesn't need organizationId or instituteId
      });

      await superAdmin.save();
      console.log('✅ Super Admin account created:', SUPER_ADMIN_EMAIL);
      console.log('   Password: 111111');
      console.log('   Unique ID:', superAdmin.uniqueId);
    }
  } catch (error) {
    console.error('⚠️  Error ensuring Super Admin account:', error.message);
    // Don't throw - server can still start without Super Admin
  }
}

export const disconnect = async () => {
  try {
    await mongoose.disconnect();
    console.log('MongoDB disconnected');
  } catch (error) {
    console.error('MongoDB disconnection error:', error);
  }
};

