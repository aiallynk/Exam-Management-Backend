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
 * @param {Model} Model - Mongoose model
 * @param {string} prefix - Entity prefix
 * @param {string} field - Field name to check uniqueness (default: 'uniqueId')
 * @returns {Promise<string>} Unique ID
 */
export const generateUniqueIdWithCheck = async (Model, prefix, field = 'uniqueId') => {
  let attempts = 0;
  const maxAttempts = 10;
  
  while (attempts < maxAttempts) {
    const uniqueId = generateUniqueId(prefix);
    const exists = await Model.findOne({ [field]: uniqueId });
    
    if (!exists) {
      return uniqueId;
    }
    
    attempts++;
  }
  
  // Fallback: add timestamp if collisions persist
  const timestamp = Date.now().toString(36).toUpperCase().slice(-4);
  return generateUniqueId(prefix) + '-' + timestamp;
};

/**
 * Entity Prefixes
 */
export const ID_PREFIXES = {
  ORGANIZATION: 'ORG',
  INSTITUTE: 'INST',
  EXAM: 'EXAM',
  SESSION: 'SESS',
  ATTEMPT: 'ATT',
  QUESTION: 'Q',
  QUESTION_PAPER: 'QP',
  USER: 'USR',
};
