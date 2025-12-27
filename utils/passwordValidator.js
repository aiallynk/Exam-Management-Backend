/**
 * Password Validation Utility
 * Provides password strength validation
 */

/**
 * Validate password strength
 * Requirements:
 * - Minimum 8 characters
 * - At least one uppercase letter
 * - At least one lowercase letter
 * - At least one number
 * - At least one special character
 * 
 * @param {string} password - Password to validate
 * @throws {Error} If password doesn't meet requirements
 * @returns {boolean} True if password is valid
 */
export function validatePasswordStrength(password) {
  if (!password || typeof password !== 'string') {
    throw new Error('Password is required');
  }
  
  // Minimum 8 characters
  if (password.length < 8) {
    throw new Error('Password must be at least 8 characters long');
  }
  
  // At least one uppercase letter
  if (!/[A-Z]/.test(password)) {
    throw new Error('Password must contain at least one uppercase letter');
  }
  
  // At least one lowercase letter
  if (!/[a-z]/.test(password)) {
    throw new Error('Password must contain at least one lowercase letter');
  }
  
  // At least one number
  if (!/[0-9]/.test(password)) {
    throw new Error('Password must contain at least one number');
  }
  
  // At least one special character
  if (!/[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?]/.test(password)) {
    throw new Error('Password must contain at least one special character');
  }
  
  return true;
}

import crypto from 'crypto';

/**
 * Generate a secure random password that meets strength requirements
 * @returns {string} Secure random password
 */
export function generateSecurePassword() {
  const uppercase = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const lowercase = 'abcdefghijkmnopqrstuvwxyz';
  const numbers = '23456789';
  const special = '!@#$%^&*';
  
  // Ensure at least one of each required character type
  let password = '';
  password += uppercase[Math.floor(Math.random() * uppercase.length)];
  password += lowercase[Math.floor(Math.random() * lowercase.length)];
  password += numbers[Math.floor(Math.random() * numbers.length)];
  password += special[Math.floor(Math.random() * special.length)];
  
  // Fill the rest randomly
  const allChars = uppercase + lowercase + numbers + special;
  for (let i = password.length; i < 12; i++) {
    password += allChars[Math.floor(Math.random() * allChars.length)];
  }
  
  // Shuffle the password
  return password.split('').sort(() => Math.random() - 0.5).join('');
}

