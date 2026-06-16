// Authentication and authorization utilities
const crypto = require('crypto');

/**
 * Simple API key authentication middleware
 */
function authenticateApiKey(req, res, next) {
  // In production, require authentication
  const requireAuth = process.env.REQUIRE_API_AUTH !== 'false';
  
  if (!requireAuth) {
    // Development mode - no auth required
    return next();
  }

  const headerApiKey = Array.isArray(req.headers['x-api-key'])
    ? req.headers['x-api-key'][0]
    : req.headers['x-api-key'];
  const authHeader = Array.isArray(req.headers.authorization)
    ? req.headers.authorization[0]
    : req.headers.authorization;
  let apiKey = headerApiKey || req.query.apiKey;

  if (!apiKey && typeof authHeader === 'string') {
    const trimmed = authHeader.trim();
    if (trimmed.toLowerCase().startsWith('bearer ')) {
      apiKey = trimmed.slice(7).trim();
    }
  }
  const expectedKey = process.env.API_KEY;

  if (!expectedKey) {
    return res.status(500).json({ 
      error: 'API_KEY not configured. Set API_KEY environment variable or set REQUIRE_API_AUTH=false for development.' 
    });
  }

  if (!apiKey || apiKey !== expectedKey) {
    return res.status(401).json({ 
      error: 'Unauthorized. Provide valid X-API-Key header or apiKey query parameter.' 
    });
  }

  next();
}

/**
 * Generate secure API key
 */
function generateApiKey() {
  return crypto.randomBytes(32).toString('hex');
}

/**
 * Validate user ID for Telegram bot
 */
function isValidTelegramUser(userId) {
  const allowedUsers = process.env.TELEGRAM_ALLOWED_USERS;
  
  if (!allowedUsers) {
    // If not configured, deny all (secure by default)
    return false;
  }

  const allowedIds = allowedUsers.split(',').map(id => id.trim());
  return allowedIds.includes(String(userId));
}

/**
 * Rate limiting per user/ip
 */
class RateLimiter {
  constructor(maxRequests = 100, windowMs = 60000) {
    this.maxRequests = maxRequests;
    this.windowMs = windowMs;
    this.requests = new Map();
  }

  isAllowed(identifier) {
    const now = Date.now();
    const userRequests = this.requests.get(identifier) || [];

    // Remove old requests outside the window
    const recentRequests = userRequests.filter(time => now - time < this.windowMs);

    if (recentRequests.length >= this.maxRequests) {
      return false;
    }

    // Add current request
    recentRequests.push(now);
    this.requests.set(identifier, recentRequests);
    return true;
  }

  reset(identifier) {
    this.requests.delete(identifier);
  }

  // Clean up old entries periodically
  cleanup() {
    const now = Date.now();
    for (const [identifier, requests] of this.requests.entries()) {
      const recentRequests = requests.filter(time => now - time < this.windowMs);
      if (recentRequests.length === 0) {
        this.requests.delete(identifier);
      } else {
        this.requests.set(identifier, recentRequests);
      }
    }
  }
}

// Global rate limiter instance
const rateLimiter = new RateLimiter(
  Number(process.env.RATE_LIMIT_MAX_REQUESTS || 100),
  Number(process.env.RATE_LIMIT_WINDOW_MS || 60000)
);

// Cleanup every 5 minutes
setInterval(() => rateLimiter.cleanup(), 5 * 60 * 1000);

module.exports = {
  authenticateApiKey,
  generateApiKey,
  isValidTelegramUser,
  rateLimiter,
  RateLimiter,
};

