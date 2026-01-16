import mongoose from 'mongoose';
import crypto from 'crypto';
import config from '../config/env.js';
import User from '../models/User.js';
import Language from '../models/Language.js';

export const connect = async () => {
  try {
    await mongoose.connect(config.mongodbUri, {
      dbName: 'exam_system',
      // Connection pool settings for better performance and resource management
      maxPoolSize: 10, // Maximum number of connections in the pool
      minPoolSize: 2, // Minimum number of connections to maintain
      maxIdleTimeMS: 30000, // Close connections after 30 seconds of inactivity
      serverSelectionTimeoutMS: 5000, // Timeout for server selection
      socketTimeoutMS: 45000, // Timeout for socket operations
      connectTimeoutMS: 10000, // Timeout for initial connection
      // Retry settings
      retryWrites: true,
      retryReads: true,
    });
    
    // Handle connection events
    mongoose.connection.on('error', (err) => {
      console.error('❌ MongoDB connection error:', err);
    });
    
    mongoose.connection.on('disconnected', () => {
      console.warn('⚠️  MongoDB disconnected');
    });
    
    mongoose.connection.on('reconnected', () => {
      console.log('✅ MongoDB reconnected');
    });
    
    console.log('✅ MongoDB connected successfully');
    
    // Auto-create Super Admin account if it doesn't exist
    await ensureSuperAdmin();
    
    // Auto-seed default languages if none exist
    await ensureDefaultLanguages();
  } catch (error) {
    console.error('❌ MongoDB connection error:', error);
    process.exit(1);
  }
};

/**
 * Ensure Super Admin account exists
 * Creates superadmin@aially.in with password from env var or generated password
 */
async function ensureSuperAdmin() {
  try {
    const SUPER_ADMIN_EMAIL = 'superadmin@aially.in';
    const SUPER_ADMIN_NAME = 'Super Admin';
    
    // Get password from environment variable, or generate random one
    let superAdminPassword = process.env.SUPER_ADMIN_PASSWORD;
    const isPasswordFromEnv = !!superAdminPassword;
    
    if (!superAdminPassword) {
      // Generate a secure random password if not provided
      superAdminPassword = crypto.randomBytes(16).toString('base64url').slice(0, 16);
    }

    const existingSuperAdmin = await User.findOne({ 
      email: SUPER_ADMIN_EMAIL
    });

    if (existingSuperAdmin) {
      // Only update password if it was explicitly set via env var (for password reset scenarios)
      // Otherwise, preserve existing password to avoid resetting it on every restart
      if (isPasswordFromEnv) {
        if (existingSuperAdmin.role !== 'SUPER_ADMIN') {
          existingSuperAdmin.role = 'SUPER_ADMIN';
        }
        existingSuperAdmin.password = superAdminPassword;
        existingSuperAdmin.status = 'ACTIVE';
        await existingSuperAdmin.save();
        console.log('✅ Super Admin account verified and password updated:', SUPER_ADMIN_EMAIL);
      } else {
        // Just ensure role and status are correct
        if (existingSuperAdmin.role !== 'SUPER_ADMIN') {
          existingSuperAdmin.role = 'SUPER_ADMIN';
          await existingSuperAdmin.save();
        }
        if (existingSuperAdmin.status !== 'ACTIVE') {
          existingSuperAdmin.status = 'ACTIVE';
          await existingSuperAdmin.save();
        }
        console.log('✅ Super Admin account verified:', SUPER_ADMIN_EMAIL);
      }
    } else {
      // Create new Super Admin
      const superAdmin = new User({
        name: SUPER_ADMIN_NAME,
        email: SUPER_ADMIN_EMAIL,
        password: superAdminPassword,
        role: 'SUPER_ADMIN',
        status: 'ACTIVE',
        // SUPER_ADMIN doesn't need organizationId or instituteId
      });

      await superAdmin.save();
      console.log('✅ Super Admin account created:', SUPER_ADMIN_EMAIL);
      console.log('   Unique ID:', superAdmin.uniqueId);
      
      // Only log password if it was auto-generated (not from env var)
      // This helps with initial setup but doesn't expose env-configured passwords
      if (!isPasswordFromEnv) {
        console.log('   ⚠️  AUTO-GENERATED PASSWORD:', superAdminPassword);
        console.log('   ⚠️  Set SUPER_ADMIN_PASSWORD env var to use a custom password');
        console.log('   ⚠️  Save this password securely - it will not be shown again!');
      } else {
        console.log('   Password configured via SUPER_ADMIN_PASSWORD environment variable');
      }
    }
  } catch (error) {
    console.error('⚠️  Error ensuring Super Admin account:', error.message);
    // Don't throw - server can still start without Super Admin
  }
}

/**
 * Ensure default languages exist
 * Seeds common languages if database is empty
 */
async function ensureDefaultLanguages() {
  try {
    const existingCount = await Language.countDocuments({ isActive: true });
    
    if (existingCount === 0) {
      console.log('📝 No languages found. Seeding default languages...');
      
      const defaultLanguages = [
        { code: 'EN', name: 'English', nativeName: 'English', isDefault: true },
        { code: 'HI', name: 'Hindi', nativeName: 'हिन्दी', isDefault: false },
        { code: 'MR', name: 'Marathi', nativeName: 'मराठी', isDefault: false },
        { code: 'GU', name: 'Gujarati', nativeName: 'ગુજરાતી', isDefault: false },
        { code: 'TA', name: 'Tamil', nativeName: 'தமிழ்', isDefault: false },
        { code: 'TE', name: 'Telugu', nativeName: 'తెలుగు', isDefault: false },
        { code: 'KN', name: 'Kannada', nativeName: 'ಕನ್ನಡ', isDefault: false },
        { code: 'ML', name: 'Malayalam', nativeName: 'മലയാളം', isDefault: false },
        { code: 'BN', name: 'Bengali', nativeName: 'বাংলা', isDefault: false },
        { code: 'UR', name: 'Urdu', nativeName: 'اردو', isDefault: false },
      ];
      
      let created = 0;
      for (const langData of defaultLanguages) {
        try {
          const existing = await Language.findOne({ code: langData.code });
          if (!existing) {
            const language = new Language({
              ...langData,
              isActive: true,
            });
            await language.save();
            created++;
          }
        } catch (error) {
          // Skip if language already exists (race condition)
          if (error.code !== 11000) {
            console.error(`  ✗ Error creating language ${langData.code}:`, error.message);
          }
        }
      }
      
      if (created > 0) {
        console.log(`✅ Seeded ${created} default languages`);
      } else {
        console.log('✅ Default languages already exist');
      }
    }
  } catch (error) {
    console.error('⚠️  Error ensuring default languages:', error.message);
    // Don't throw - server can still start without languages
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

