const config = require('../config');
const { error } = require('../utils/response');

// Simple in-process store (replace with Redis for multi-instance deployments)
const store = new Map();

const rateLimit = (windowMs = config.rateLimit.windowMs, max = config.rateLimit.max) =>
  (req, res, next) => {
    const key = req.ip || 'unknown';
    const now = Date.now();
    const entry = store.get(key) || { count: 0, resetAt: now + windowMs };

    if (now > entry.resetAt) {
      entry.count = 0;
      entry.resetAt = now + windowMs;
    }

    entry.count += 1;
    store.set(key, entry);

    res.setHeader('X-RateLimit-Limit', max);
    res.setHeader('X-RateLimit-Remaining', Math.max(0, max - entry.count));
    res.setHeader('X-RateLimit-Reset', Math.ceil(entry.resetAt / 1000));

    if (entry.count > max) {
      return error(res, 'Too many requests', 429);
    }
    next();
  };

module.exports = { rateLimit };
