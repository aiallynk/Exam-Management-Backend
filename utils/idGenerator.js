/**
 * Unique ID Generator Utility
 * Generates human-readable, unique IDs for all entities
 */

import crypto from 'crypto';

/**
 * Generate a unique, human-readable ID
 * Format: PREFIX-XXXX-XXXX (e.g., ORG-A1B2-C3D4)
 * 
 * @param {string} prefix - Entity prefix (ORG, INST, EXAM, SESS, etc.)
 * @param {number} length - Length of ID segments (default: 4)
 * @returns {string} Unique ID
 */
export const generateUniqueId = (prefix, length = 4) => {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // Excludes confusing chars (0, O, I, 1)
  const segments = 2; // Two segments: XXXX-XXXX
  
  let id = prefix.toUpperCase() + '-';
  
  for (let s = 0; s < segments; s++) {
    let segment = '';
    for (let i = 0; i < length; i++) {
      const randomIndex = crypto.randomInt(0, chars.length);
      segment += chars[randomIndex];
    }
    id += segment;
    if (s < segments - 1) id += '-';
  }
  
  return id;
};

/**
 * Generate unique ID and check for collisions
 * Uses database unique constraint as the source of truth to prevent race conditions
 * @param {Model} Model - Mongoose model
 * @param {string} prefix - Entity prefix
 * @param {string} field - Field name to check uniqueness (default: 'uniqueId')
 * @returns {Promise<string>} Unique ID
 */
export const generateUniqueIdWithCheck = async (Model, prefix, field = 'uniqueId') => {
  let attempts = 0;
  const maxAttempts = 15; // Increased attempts for better collision handling
  
  while (attempts < maxAttempts) {
    const uniqueId = generateUniqueId(prefix);
    
    try {
      // Quick check first (optimization)
      const exists = await Model.findOne({ [field]: uniqueId }).lean();
      if (!exists) {
        return uniqueId;
      }
    } catch (error) {
      // If check fails, try next ID
      attempts++;
      continue;
    }
    
    attempts++;
    
    // Add small random delay to reduce collision probability in high concurrency
    if (attempts > 5) {
      await new Promise(resolve => setTimeout(resolve, Math.random() * 10));
    }
  }
  
  // Fallback: add timestamp and random suffix if collisions persist
  const timestamp = Date.now().toString(36).toUpperCase().slice(-4);
  const randomSuffix = generateUniqueId('', 2).replace(/^-/, ''); // Generate 2-char suffix
  return generateUniqueId(prefix) + '-' + timestamp + '-' + randomSuffix;
};

/**
 * Entity Prefixes
 */
export const ID_PREFIXES = {
  ORGANIZATION: 'ORG',
  INSTITUTE: 'INST',
  TENANT: 'TNT',
  EXAM: 'EXAM',
  SESSION: 'SESS',
  ATTEMPT: 'ATT',
  QUESTION: 'Q',
  QUESTION_PAPER: 'QP',
  USER: 'USR',
  EXAM_PARTICIPANT: 'EP',
  SECTION: 'SEC',
  EXAMINER_ASSIGNMENT: 'EXA',
};
