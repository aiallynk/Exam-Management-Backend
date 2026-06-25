import mongoose from 'mongoose';
import dns from 'dns';
import crypto from 'crypto';
import config from '../config/env.js';
import User from '../models/User.js';
import Language from '../models/Language.js';
import { initializeSubscriptionPlanCatalog } from './subscriptionPlanCatalog.js';

const MONGO_CONNECT_OPTIONS = {
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
};

const DEFAULT_CONNECT_RETRIES = 4;
const DEFAULT_RETRY_DELAY_MS = 1000;
const SRV_FALLBACK_DNS_SERVERS = ['1.1.1.1', '8.8.8.8'];

let connectionEventHandlersRegistered = false;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const isMongoSrvUri = (uri) => typeof uri === 'string' && uri.startsWith('mongodb+srv://');

const isSrvDnsLookupError = (error) => {
  const queue = [error];
  const visited = new Set();

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || visited.has(current)) continue;
    visited.add(current);

    if (
      current.syscall === 'querySrv' &&
      ['EREFUSED', 'ENOTFOUND', 'ETIMEOUT', 'EAI_AGAIN', 'ECONNREFUSED', 'ECONNRESET'].includes(current.code)
    ) {
      return true;
    }

    if (current.cause) queue.push(current.cause);
    if (current.reason) queue.push(current.reason);
    if (current.originalError) queue.push(current.originalError);
    if (Array.isArray(current.errors)) queue.push(...current.errors);
  }

  return false;
};

const normalizeCredential = (value) => {
  if (!value) return '';

  try {
    return encodeURIComponent(decodeURIComponent(value));
  } catch {
    return encodeURIComponent(value);
  }
};

const buildMongoUriFromSrvRecords = async (mongoSrvUri) => {
  const parsedUri = new URL(mongoSrvUri);
  const resolver = new dns.promises.Resolver();
  resolver.setServers(SRV_FALLBACK_DNS_SERVERS);

  const srvLookupHost = `_mongodb._tcp.${parsedUri.hostname}`;
  const srvRecords = await resolver.resolveSrv(srvLookupHost);

  if (!srvRecords.length) {
    throw new Error(`No SRV records found for ${srvLookupHost}`);
  }

  const hosts = srvRecords
    .sort((left, right) => (
      left.priority - right.priority ||
      right.weight - left.weight ||
      left.name.localeCompare(right.name)
    ))
    .map((record) => `${record.name.replace(/\.$/, '')}:${record.port}`)
    .join(',');

  const queryParams = new URLSearchParams(parsedUri.searchParams);

  try {
    const txtRecords = await resolver.resolveTxt(parsedUri.hostname);
    for (const record of txtRecords) {
      const txtEntry = Array.isArray(record) ? record.join('') : String(record);
      const txtParams = new URLSearchParams(txtEntry);
      for (const [key, value] of txtParams.entries()) {
        if (!queryParams.has(key)) {
          queryParams.set(key, value);
        }
      }
    }
  } catch {
    // TXT record is optional. If unavailable, keep the original query options.
  }

  // SRV connections default to TLS. Preserve equivalent behavior on standard URI.
  if (!queryParams.has('tls') && !queryParams.has('ssl')) {
    queryParams.set('tls', 'true');
  }

  const username = normalizeCredential(parsedUri.username);
  const password = normalizeCredential(parsedUri.password);
  const authPart = username ? `${username}${password ? `:${password}` : ''}@` : '';
  const dbPath = parsedUri.pathname && parsedUri.pathname !== '/' ? parsedUri.pathname : '/';
  const queryString = queryParams.toString();

  return `mongodb://${authPart}${hosts}${dbPath}${queryString ? `?${queryString}` : ''}`;
};

const registerConnectionEventHandlers = () => {
  if (connectionEventHandlersRegistered) return;

  mongoose.connection.on('error', (err) => {
    console.error('❌ MongoDB connection error:', err);
  });

  mongoose.connection.on('disconnected', () => {
    console.warn('⚠️  MongoDB disconnected');
  });

  mongoose.connection.on('reconnected', () => {
    console.log('✅ MongoDB reconnected');
  });

  connectionEventHandlersRegistered = true;
};

const finalizeSuccessfulConnection = async (usedSrvDnsFallback) => {
  registerConnectionEventHandlers();

  if (usedSrvDnsFallback) {
    console.warn('⚠️  MongoDB connected using SRV DNS fallback hosts');
  }

  console.log('✅ MongoDB connected successfully');

  // Auto-create Super Admin account if it doesn't exist
  await ensureSuperAdmin();

  // Auto-seed default languages if none exist
  await ensureDefaultLanguages();

  // Load persisted subscription plan catalog overrides
  try {
    await initializeSubscriptionPlanCatalog();
  } catch (error) {
    console.warn('⚠️  Failed to load subscription plan catalog overrides:', error.message);
  }
};

export const connect = async () => {
  const maxAttempts = Math.max(
    1,
    Number.parseInt(process.env.MONGODB_CONNECT_RETRIES || `${DEFAULT_CONNECT_RETRIES}`, 10),
  );
  const initialDelayMs = Math.max(
    250,
    Number.parseInt(process.env.MONGODB_CONNECT_RETRY_DELAY_MS || `${DEFAULT_RETRY_DELAY_MS}`, 10),
  );

  let connectionUri = config.mongodbUri;
  let usedSrvDnsFallback = false;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await mongoose.connect(connectionUri, MONGO_CONNECT_OPTIONS);
      await finalizeSuccessfulConnection(usedSrvDnsFallback);
      return;
    } catch (error) {
      if (
        !usedSrvDnsFallback &&
        isMongoSrvUri(config.mongodbUri) &&
        connectionUri === config.mongodbUri &&
        isSrvDnsLookupError(error)
      ) {
        try {
          connectionUri = await buildMongoUriFromSrvRecords(config.mongodbUri);
          usedSrvDnsFallback = true;
          console.warn('⚠️  SRV lookup failed. Retrying with resolved MongoDB hosts...');

          await mongoose.connect(connectionUri, MONGO_CONNECT_OPTIONS);
          await finalizeSuccessfulConnection(true);
          return;
        } catch (fallbackError) {
          console.warn('⚠️  Unable to connect using SRV DNS fallback:', fallbackError.message);
        }
      }

      const isLastAttempt = attempt === maxAttempts;
      if (isLastAttempt) {
        console.error('❌ MongoDB connection error:', error);
        throw error;
      }

      const retryDelayMs = initialDelayMs * (2 ** (attempt - 1));
      console.warn(
        `⚠️  MongoDB connection attempt ${attempt}/${maxAttempts} failed: ${error.message}`,
      );
      console.warn(`↻ Retrying in ${retryDelayMs}ms...`);

      try {
        if (mongoose.connection.readyState !== 0) {
          await mongoose.disconnect();
        }
      } catch {
        // Ignore cleanup errors between retries.
      }

      await sleep(retryDelayMs);
    }
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
      email: SUPER_ADMIN_EMAIL,
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
        { code: 'HI', name: 'Hindi', nativeName: '\u0939\u093f\u0928\u094d\u0926\u0940', isDefault: false },
        { code: 'MR', name: 'Marathi', nativeName: '\u092e\u0930\u093e\u0920\u0940', isDefault: false },
        { code: 'GU', name: 'Gujarati', nativeName: '\u0a97\u0ac1\u0a9c\u0ab0\u0abe\u0aa4\u0ac0', isDefault: false },
        { code: 'TA', name: 'Tamil', nativeName: '\u0ba4\u0bae\u0bbf\u0bb4\u0bcd', isDefault: false },
        { code: 'TE', name: 'Telugu', nativeName: '\u0c24\u0c46\u0c32\u0c41\u0c17\u0c41', isDefault: false },
        { code: 'KN', name: 'Kannada', nativeName: '\u0c95\u0ca8\u0ccd\u0ca8\u0ca1', isDefault: false },
        { code: 'ML', name: 'Malayalam', nativeName: '\u0d2e\u0d32\u0d2f\u0d3e\u0d33\u0d02', isDefault: false },
        { code: 'BN', name: 'Bengali', nativeName: '\u09ac\u09be\u0982\u09b2\u09be', isDefault: false },
        { code: 'UR', name: 'Urdu', nativeName: '\u0627\u0631\u062f\u0648', isDefault: false },
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
            created += 1;
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
