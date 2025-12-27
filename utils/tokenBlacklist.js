/**
 * Token Blacklist Utility
 * Tracks invalidated tokens (logout, password change, etc.)
 * 
 * NOTE: This uses in-memory storage. For production with multiple servers,
 * use Redis or a shared database for the blacklist.
 */

// In-memory blacklist: Map<token, expiryTimestamp>
// Tokens are automatically cleaned up after expiry
const blacklist = new Map();

/**
 * Add a token to the blacklist
 * @param {string} token - JWT token to blacklist
 * @param {number} expiresInSeconds - Token expiration time in seconds
 */
export function addToBlacklist(token, expiresInSeconds) {
  if (!token) return;
  
  // Calculate expiry timestamp
  const expiresAt = Date.now() + (expiresInSeconds * 1000);
  blacklist.set(token, expiresAt);
  
  // Schedule cleanup after expiry (with some buffer)
  setTimeout(() => {
    blacklist.delete(token);
  }, expiresInSeconds * 1000 + 1000); // 1 second buffer
}

/**
 * Check if a token is blacklisted
 * @param {string} token - JWT token to check
 * @returns {boolean} True if token is blacklisted
 */
export function isBlacklisted(token) {
  if (!token) return false;
  
  const expiresAt = blacklist.get(token);
  if (!expiresAt) return false;
  
  // If token has expired, remove it and return false
  if (Date.now() > expiresAt) {
    blacklist.delete(token);
    return false;
  }
  
  return true;
}

/**
 * Clean up expired tokens from blacklist
 * Should be called periodically (e.g., every hour)
 */
export function cleanupExpiredTokens() {
  const now = Date.now();
  let cleaned = 0;
  
  for (const [token, expiresAt] of blacklist.entries()) {
    if (now > expiresAt) {
      blacklist.delete(token);
      cleaned++;
    }
  }
  
  if (cleaned > 0) {
    console.log(`🧹 Cleaned up ${cleaned} expired tokens from blacklist`);
  }
  
  return cleaned;
}

/**
 * Get blacklist size (for monitoring)
 * @returns {number} Number of tokens in blacklist
 */
export function getBlacklistSize() {
  return blacklist.size;
}

// Clean up expired tokens every hour
setInterval(cleanupExpiredTokens, 60 * 60 * 1000);

