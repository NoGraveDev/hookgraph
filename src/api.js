/**
 * HookGraph REST API
 * Manages API keys, subscriptions, and webhook configuration
 */

const express = require('express');
const crypto = require('crypto');
const { randomUUID } = require('crypto');
const db = require('./db');
const { getDeliveryStats } = require('./delivery');
const { getProvider } = require('./mirror');

const router = express.Router();

// ─── Constants ───

const MAX_NAME_LENGTH = 100;
const MAX_SUBSCRIPTIONS_PER_KEY = 50;
const MAX_FILTER_JSON_LENGTH = 4096;
const MAX_SECRET_LENGTH = 256;

// ─── Security: Private IP blocklist for SSRF prevention ───

const BLOCKED_IP_RANGES = [
  /^127\./, /^10\./, /^172\.(1[6-9]|2\d|3[01])\./, /^192\.168\./,
  /^169\.254\./, /^0\./, /^fc00:/i, /^fe80:/i, /^::1$/, /^localhost$/i,
  /^.*\.local$/i, /^\[/, // block IPv6 bracket notation
];

function isPrivateUrl(urlStr) {
  try {
    const url = new URL(urlStr);
    const hostname = url.hostname;
    return BLOCKED_IP_RANGES.some(re => re.test(hostname));
  } catch {
    return true; // Invalid URL = blocked
  }
}

function validateWebhookUrl(urlStr) {
  if (typeof urlStr !== 'string') return 'webhook_url must be a string';
  if (urlStr.length > 2048) return 'webhook_url too long (max 2048 chars)';

  try {
    const url = new URL(urlStr);
    if (!['http:', 'https:'].includes(url.protocol)) {
      return 'webhook_url must be http or https';
    }
    if (url.username || url.password) {
      return 'webhook_url must not contain credentials';
    }
    if (process.env.NODE_ENV !== 'test' && isPrivateUrl(urlStr)) {
      return 'webhook_url cannot point to private/internal addresses';
    }
    return null;
  } catch {
    return 'Invalid webhook_url';
  }
}

// ─── Rate limiting for key creation ───

const keyCreationTracker = new Map(); // IP -> { count, resetAt }
const KEY_CREATION_LIMIT = 5; // per hour
const KEY_CREATION_WINDOW_MS = 3600000;

// Periodic cleanup of stale rate limit entries (every 10 min)
const _rateLimitCleanup = setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of keyCreationTracker) {
    if (now > entry.resetAt) keyCreationTracker.delete(ip);
  }
}, 600000);
_rateLimitCleanup.unref();

function checkKeyCreationLimit(ip) {
  const now = Date.now();
  const entry = keyCreationTracker.get(ip);
  if (!entry || now > entry.resetAt) {
    keyCreationTracker.set(ip, { count: 1, resetAt: now + KEY_CREATION_WINDOW_MS });
    return true;
  }
  if (entry.count >= KEY_CREATION_LIMIT) return false;
  entry.count++;
  return true;
}

// ─── Helpers ───

function hashKey(key) {
  return crypto.createHash('sha256').update(key).digest('hex');
}

function generateApiKey() {
  return 'hg_' + crypto.randomBytes(24).toString('hex');
}

function authenticateRequest(req, res, next) {
  const authHeader = req.headers['authorization'];
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing or invalid Authorization header. Use: Bearer <api_key>' });
  }

  const key = authHeader.slice(7).trim();
  if (!key || key.length < 10) {
    return res.status(401).json({ error: 'Invalid API key format' });
  }

  const keyHash = hashKey(key);
  try {
    const apiKey = db.prepare('SELECT * FROM api_keys WHERE key_hash = ?').get(keyHash);
    if (!apiKey) {
      return res.status(401).json({ error: 'Invalid API key' });
    }
    req.apiKey = apiKey;
    next();
  } catch (err) {
    console.error('[api] Auth DB error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
}

// ─── Async error wrapper ───

function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

// ─── Validation helpers ───

function validateUUID(str) {
  return typeof str === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(str);
}

function validateSubId(req, res) {
  if (!validateUUID(req.params.id)) {
    res.status(400).json({ error: 'Invalid subscription ID format' });
    return null;
  }
  const sub = db.prepare(
    'SELECT * FROM subscriptions WHERE id = ? AND api_key_id = ?'
  ).get(req.params.id, req.apiKey.id);
  if (!sub) {
    res.status(404).json({ error: 'Subscription not found' });
    return null;
  }
  return sub;
}

// ─── Public Routes ───

/**
 * POST /api/v1/keys — Create API key (rate limited, no auth)
 */
router.post('/keys', (req, res) => {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  if (!checkKeyCreationLimit(ip)) {
    return res.status(429).json({ error: 'Too many API keys created. Try again later.' });
  }

  const { name } = req.body || {};

  // Validate name
  if (name !== undefined) {
    if (typeof name !== 'string' || name.length > MAX_NAME_LENGTH) {
      return res.status(400).json({ error: `name must be a string (max ${MAX_NAME_LENGTH} chars)` });
    }
  }

  const key = generateApiKey();
  const id = randomUUID();
  const keyHash = hashKey(key);
  const sanitizedName = name ? name.slice(0, MAX_NAME_LENGTH).trim() : 'default';

  try {
    db.prepare(`
      INSERT INTO api_keys (id, key_hash, name, tier) VALUES (?, ?, ?, 'free')
    `).run(id, keyHash, sanitizedName);

    res.status(201).json({
      id,
      api_key: key,
      name: sanitizedName,
      tier: 'free',
      limits: { topics: 3, daily_webhooks: 500 },
      message: 'Save this API key — it cannot be retrieved later.',
    });
  } catch (err) {
    console.error('[api] Key creation error:', err.message);
    res.status(500).json({ error: 'Failed to create API key' });
  }
});

// ─── Authenticated Routes ───

/**
 * GET /api/v1/account — Account info and usage
 */
router.get('/account', authenticateRequest, (req, res) => {
  try {
    const subs = db.prepare('SELECT COUNT(*) as count FROM subscriptions WHERE api_key_id = ? AND active = 1').get(req.apiKey.id);
    const topics = db.prepare('SELECT COUNT(DISTINCT topic_id) as count FROM subscriptions WHERE api_key_id = ? AND active = 1').get(req.apiKey.id);

    const todayStart = Math.floor(Date.now() / 86400000) * 86400;
    const todayDeliveries = db.prepare(`
      SELECT COUNT(*) as count FROM deliveries d
      JOIN subscriptions s ON d.subscription_id = s.id
      WHERE s.api_key_id = ? AND d.created_at >= ?
    `).get(req.apiKey.id, todayStart);

    res.json({
      id: req.apiKey.id,
      name: req.apiKey.name,
      tier: req.apiKey.tier,
      created_at: req.apiKey.created_at,
      usage: {
        active_subscriptions: subs.count,
        active_topics: topics.count,
        topics_limit: req.apiKey.topics_limit,
        daily_webhooks_used: todayDeliveries.count,
        daily_webhooks_limit: req.apiKey.daily_webhook_limit,
      },
    });
  } catch (err) {
    console.error('[api] Account fetch error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /api/v1/subscriptions — Subscribe to an HCS topic
 */
router.post('/subscriptions', authenticateRequest, asyncHandler(async (req, res) => {
  const { topic_id, webhook_url, secret, filters } = req.body || {};

  // Required fields
  if (!topic_id || !webhook_url) {
    return res.status(400).json({ error: 'topic_id and webhook_url are required' });
  }

  // Validate types
  if (typeof topic_id !== 'string' || typeof webhook_url !== 'string') {
    return res.status(400).json({ error: 'topic_id and webhook_url must be strings' });
  }

  if (!/^\d+\.\d+\.\d+$/.test(topic_id)) {
    return res.status(400).json({ error: 'Invalid topic_id format. Expected: 0.0.XXXXX' });
  }

  const urlError = validateWebhookUrl(webhook_url);
  if (urlError) {
    return res.status(400).json({ error: urlError });
  }

  // Validate optional secret
  if (secret !== undefined) {
    if (typeof secret !== 'string' || secret.length > MAX_SECRET_LENGTH) {
      return res.status(400).json({ error: `secret must be a string (max ${MAX_SECRET_LENGTH} chars)` });
    }
  }

  // Validate optional filters
  if (filters !== undefined && filters !== null) {
    if (typeof filters !== 'object' || Array.isArray(filters)) {
      return res.status(400).json({ error: 'filters must be an object' });
    }
    const filterStr = JSON.stringify(filters);
    if (filterStr.length > MAX_FILTER_JSON_LENGTH) {
      return res.status(400).json({ error: `filters too large (max ${MAX_FILTER_JSON_LENGTH} chars)` });
    }
  }

  // Check total subscription limit
  const subCount = db.prepare(
    'SELECT COUNT(*) as count FROM subscriptions WHERE api_key_id = ?'
  ).get(req.apiKey.id);

  if (subCount.count >= MAX_SUBSCRIPTIONS_PER_KEY) {
    return res.status(429).json({
      error: `Subscription limit reached (${MAX_SUBSCRIPTIONS_PER_KEY}).`,
    });
  }

  // Check topic limit
  const topicCount = db.prepare(
    'SELECT COUNT(DISTINCT topic_id) as count FROM subscriptions WHERE api_key_id = ? AND active = 1'
  ).get(req.apiKey.id);

  const existingTopic = db.prepare(
    'SELECT 1 FROM subscriptions WHERE api_key_id = ? AND topic_id = ? AND active = 1'
  ).get(req.apiKey.id, topic_id);

  if (!existingTopic && topicCount.count >= req.apiKey.topics_limit) {
    return res.status(429).json({
      error: `Topic limit reached (${req.apiKey.topics_limit}). Upgrade to add more topics.`,
    });
  }

  // Check duplicate
  const existing = db.prepare(
    'SELECT id FROM subscriptions WHERE api_key_id = ? AND topic_id = ? AND webhook_url = ? AND active = 1'
  ).get(req.apiKey.id, topic_id, webhook_url);

  if (existing) {
    return res.status(409).json({ error: 'Subscription already exists', id: existing.id });
  }

  const id = randomUUID();
  const webhookSecret = secret || crypto.randomBytes(32).toString('hex');

  // Get current latest sequence so we don't replay history
  let startSequence = 0;
  let startTimestamp = null;
  try {
    const provider = getProvider();
    const mirrorRes = await fetch(
      `${provider.base}/api/v1/topics/${encodeURIComponent(topic_id)}/messages?limit=1&order=desc`,
      { signal: AbortSignal.timeout(10000) }
    );
    if (mirrorRes.ok) {
      const mirrorData = await mirrorRes.json();
      if (mirrorData.messages && mirrorData.messages.length > 0) {
        startSequence = mirrorData.messages[0].sequence_number;
        startTimestamp = mirrorData.messages[0].consensus_timestamp;
      }
    }
  } catch (err) {
    console.warn(`[api] Could not fetch latest sequence for ${topic_id}: ${err.message}`);
  }

  db.prepare(`
    INSERT INTO subscriptions (id, api_key_id, topic_id, webhook_url, secret, filter_json, last_sequence, last_timestamp)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, req.apiKey.id, topic_id, webhook_url, webhookSecret, filters ? JSON.stringify(filters) : null, startSequence, startTimestamp);

  res.status(201).json({
    id,
    topic_id,
    webhook_url,
    secret: webhookSecret,
    filters: filters || null,
    active: true,
    starting_sequence: startSequence,
    message: 'Subscription created. Webhook deliveries will begin on next poll cycle.',
  });
}));

/**
 * GET /api/v1/subscriptions — List subscriptions
 */
router.get('/subscriptions', authenticateRequest, (req, res) => {
  try {
    const subs = db.prepare(
      'SELECT id, topic_id, webhook_url, active, created_at, last_sequence FROM subscriptions WHERE api_key_id = ?'
    ).all(req.apiKey.id);

    const result = subs.map(sub => ({
      ...sub,
      active: !!sub.active,
      deliveries: getDeliveryStats(sub.id),
    }));

    res.json({ subscriptions: result });
  } catch (err) {
    console.error('[api] List subs error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/v1/subscriptions/:id — Subscription details (secret redacted)
 */
router.get('/subscriptions/:id', authenticateRequest, (req, res) => {
  const sub = validateSubId(req, res);
  if (!sub) return;

  // Redact secret — only shown at creation
  const { secret, ...safe } = sub;
  res.json({
    ...safe,
    active: !!safe.active,
    has_secret: !!secret,
    filter_json: safe.filter_json ? (() => { try { return JSON.parse(safe.filter_json); } catch { return null; } })() : null,
    deliveries: getDeliveryStats(sub.id),
  });
});

/**
 * PATCH /api/v1/subscriptions/:id — Update subscription
 */
router.patch('/subscriptions/:id', authenticateRequest, (req, res) => {
  const sub = validateSubId(req, res);
  if (!sub) return;

  const { active, webhook_url, filters } = req.body || {};

  // Validate at least one field
  if (active === undefined && webhook_url === undefined && filters === undefined) {
    return res.status(400).json({ error: 'No update fields provided. Use: active, webhook_url, or filters' });
  }

  try {
    if (active !== undefined) {
      if (typeof active !== 'boolean') {
        return res.status(400).json({ error: 'active must be a boolean' });
      }
      db.prepare('UPDATE subscriptions SET active = ? WHERE id = ?').run(active ? 1 : 0, sub.id);
    }
    if (webhook_url !== undefined) {
      const urlError = validateWebhookUrl(webhook_url);
      if (urlError) return res.status(400).json({ error: urlError });
      db.prepare('UPDATE subscriptions SET webhook_url = ? WHERE id = ?').run(webhook_url, sub.id);
    }
    if (filters !== undefined) {
      if (filters !== null && (typeof filters !== 'object' || Array.isArray(filters))) {
        return res.status(400).json({ error: 'filters must be an object or null' });
      }
      if (filters && JSON.stringify(filters).length > MAX_FILTER_JSON_LENGTH) {
        return res.status(400).json({ error: `filters too large (max ${MAX_FILTER_JSON_LENGTH} chars)` });
      }
      db.prepare('UPDATE subscriptions SET filter_json = ? WHERE id = ?').run(
        filters ? JSON.stringify(filters) : null, sub.id
      );
    }

    const updated = db.prepare('SELECT id, topic_id, webhook_url, active, filter_json, last_sequence, created_at FROM subscriptions WHERE id = ?').get(sub.id);
    res.json({ ...updated, active: !!updated.active });
  } catch (err) {
    console.error('[api] Update error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * DELETE /api/v1/subscriptions/:id
 */
router.delete('/subscriptions/:id', authenticateRequest, (req, res) => {
  const sub = validateSubId(req, res);
  if (!sub) return;

  try {
    db.prepare('DELETE FROM subscriptions WHERE id = ?').run(sub.id);
    res.json({ deleted: true, id: sub.id });
  } catch (err) {
    console.error('[api] Delete error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/v1/subscriptions/:id/deliveries — Delivery history
 */
router.get('/subscriptions/:id/deliveries', authenticateRequest, (req, res) => {
  const sub = validateSubId(req, res);
  if (!sub) return;

  const limitParam = parseInt(req.query.limit);
  const limit = Number.isFinite(limitParam) ? Math.min(Math.max(limitParam, 1), 200) : 50;

  try {
    const deliveries = db.prepare(`
      SELECT id, message_sequence, consensus_timestamp, status, attempts, last_attempt_at, response_code, created_at
      FROM deliveries WHERE subscription_id = ?
      ORDER BY created_at DESC LIMIT ?
    `).all(sub.id, limit);

    res.json({ deliveries });
  } catch (err) {
    console.error('[api] Deliveries fetch error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /api/v1/subscriptions/:id/test — Send test webhook
 */
router.post('/subscriptions/:id/test', authenticateRequest, asyncHandler(async (req, res) => {
  const sub = validateSubId(req, res);
  if (!sub) return;

  const testPayload = {
    event: 'test',
    topic_id: sub.topic_id,
    sequence_number: 0,
    consensus_timestamp: new Date().toISOString(),
    payer_account_id: '0.0.0',
    message: { test: true, message: 'HookGraph test webhook' },
    raw_message_base64: Buffer.from('HookGraph test').toString('base64'),
  };

  const signature = sub.secret
    ? crypto.createHmac('sha256', sub.secret).update(JSON.stringify(testPayload)).digest('hex')
    : null;

  try {
    const r = await fetch(sub.webhook_url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'HookGraph/1.0',
        'X-HookGraph-Topic': sub.topic_id,
        'X-HookGraph-Event': 'test',
        ...(signature ? { 'X-HookGraph-Signature': `sha256=${signature}` } : {}),
      },
      body: JSON.stringify(testPayload),
      signal: AbortSignal.timeout(10000),
      redirect: 'error',
    });
    res.json({ success: r.ok, status: r.status, statusText: r.statusText });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
}));

module.exports = router;
