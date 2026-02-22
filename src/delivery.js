/**
 * Webhook Delivery Engine
 * Handles queuing, sending, and retrying webhook deliveries
 * Enforces daily webhook limits per API key
 */

const crypto = require('crypto');
const db = require('./db');

const MAX_RETRIES = 5;
const RETRY_DELAYS = [5000, 15000, 60000, 300000, 900000]; // 5s, 15s, 1m, 5m, 15m
const DELIVERY_TIMEOUT_MS = 10000;
const MAX_QUEUE_SIZE = 10000; // Prevent memory exhaustion
const MAX_CONCURRENT_DELIVERIES = 10; // Parallel delivery limit

const deliveryQueue = [];
let activeDeliveries = 0;
const retryTimers = new Set(); // Track for graceful shutdown

/**
 * Sign a webhook payload with the subscription's secret
 */
function signPayload(payload, secret) {
  if (!secret) return null;
  const body = JSON.stringify(payload);
  return crypto.createHmac('sha256', secret).update(body).digest('hex');
}

/**
 * Check if the API key has exceeded its daily webhook limit
 */
function checkDailyLimit(apiKeyId) {
  try {
    const apiKey = db.prepare('SELECT daily_webhook_limit FROM api_keys WHERE id = ?').get(apiKeyId);
    if (!apiKey) return false;

    const todayStart = Math.floor(Date.now() / 86400000) * 86400; // UTC midnight in seconds
    const count = db.prepare(`
      SELECT COUNT(*) as count FROM deliveries d
      JOIN subscriptions s ON d.subscription_id = s.id
      WHERE s.api_key_id = ? AND d.created_at >= ?
    `).get(apiKeyId, todayStart);

    return count.count < apiKey.daily_webhook_limit;
  } catch (err) {
    console.error('[delivery] Error checking daily limit:', err.message);
    return false; // Fail closed
  }
}

/**
 * Queue a delivery for processing
 */
function queueDelivery(subscription, payload) {
  // Enforce queue size limit
  if (deliveryQueue.length >= MAX_QUEUE_SIZE) {
    console.warn('[delivery] Queue full, dropping oldest delivery');
    const dropped = deliveryQueue.shift();
    if (dropped) {
      try {
        db.prepare(`UPDATE deliveries SET status = 'dropped' WHERE id = ?`).run(dropped.deliveryId);
      } catch {}
    }
  }

  // Check daily limit
  if (!checkDailyLimit(subscription.api_key_id)) {
    console.warn(`[delivery] Daily limit reached for API key ${subscription.api_key_id}, skipping`);
    return;
  }

  try {
    const result = db.prepare(`
      INSERT INTO deliveries (subscription_id, message_sequence, consensus_timestamp, status)
      VALUES (?, ?, ?, 'pending')
    `).run(subscription.id, payload.sequence_number, payload.consensus_timestamp);

    deliveryQueue.push({
      deliveryId: result.lastInsertRowid,
      subscription,
      payload,
      attempts: 0,
    });

    drainQueue();
  } catch (err) {
    console.error('[delivery] Error queuing delivery:', err.message);
  }
}

/**
 * Drain the delivery queue with concurrency control
 */
function drainQueue() {
  while (deliveryQueue.length > 0 && activeDeliveries < MAX_CONCURRENT_DELIVERIES) {
    const item = deliveryQueue.shift();
    activeDeliveries++;
    deliver(item).finally(() => {
      activeDeliveries--;
      // Continue draining after each completion
      if (deliveryQueue.length > 0) drainQueue();
    });
  }
}

/**
 * Deliver a single webhook
 */
async function deliver(item) {
  const { deliveryId, subscription, payload, attempts } = item;

  // Re-check subscription is still active before delivering
  try {
    const sub = db.prepare('SELECT active FROM subscriptions WHERE id = ?').get(subscription.id);
    if (!sub || !sub.active) {
      db.prepare(`UPDATE deliveries SET status = 'cancelled' WHERE id = ?`).run(deliveryId);
      return;
    }
  } catch {}

  const body = JSON.stringify(payload);
  const signature = signPayload(payload, subscription.secret);

  const headers = {
    'Content-Type': 'application/json',
    'User-Agent': 'HookGraph/1.0',
    'X-HookGraph-Topic': payload.topic_id,
    'X-HookGraph-Sequence': String(payload.sequence_number),
    'X-HookGraph-Timestamp': payload.consensus_timestamp,
    'X-HookGraph-Delivery-Id': String(deliveryId),
    'X-HookGraph-Attempt': String(attempts + 1),
  };

  if (signature) {
    headers['X-HookGraph-Signature'] = `sha256=${signature}`;
  }

  try {
    const res = await fetch(subscription.webhook_url, {
      method: 'POST',
      headers,
      body,
      signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
      redirect: 'error', // Don't follow redirects (SSRF mitigation)
    });

    const status = res.ok ? 'delivered' : (attempts + 1 >= MAX_RETRIES ? 'dead' : 'retry');

    db.prepare(`
      UPDATE deliveries SET status = ?, attempts = ?, last_attempt_at = unixepoch(), response_code = ?
      WHERE id = ?
    `).run(status, attempts + 1, res.status, deliveryId);

    if (!res.ok) {
      scheduleRetry(item, attempts);
    }
  } catch (err) {
    const status = attempts + 1 >= MAX_RETRIES ? 'dead' : 'retry';

    console.error(`[delivery] Error sending to ${subscription.webhook_url}: ${err.message}`);

    try {
      db.prepare(`
        UPDATE deliveries SET status = ?, attempts = ?, last_attempt_at = unixepoch()
        WHERE id = ?
      `).run(status, attempts + 1, deliveryId);
    } catch (dbErr) {
      console.error('[delivery] DB update failed:', dbErr.message);
    }

    scheduleRetry(item, attempts);
  }
}

function scheduleRetry(item, attempts) {
  if (attempts + 1 >= MAX_RETRIES) {
    console.error(`[delivery] ${item.subscription.webhook_url} failed after ${MAX_RETRIES} attempts, dead-lettered`);
    return;
  }

  const delay = RETRY_DELAYS[attempts] || RETRY_DELAYS[RETRY_DELAYS.length - 1];
  console.warn(`[delivery] Retry #${attempts + 1} in ${delay / 1000}s for ${item.subscription.webhook_url}`);

  const timer = setTimeout(() => {
    retryTimers.delete(timer);
    deliveryQueue.push({ ...item, attempts: attempts + 1 });
    drainQueue();
  }, delay);

  // Don't block shutdown for retries
  timer.unref();
  retryTimers.add(timer);
}

/**
 * Get delivery stats for a subscription
 */
function getDeliveryStats(subscriptionId) {
  try {
    return db.prepare(`
      SELECT 
        status, 
        COUNT(*) as count,
        MAX(last_attempt_at) as last_attempt
      FROM deliveries 
      WHERE subscription_id = ?
      GROUP BY status
    `).all(subscriptionId);
  } catch {
    return [];
  }
}

/**
 * Get queue depth info for health checks
 */
function getQueueInfo() {
  return {
    queued: deliveryQueue.length,
    active: activeDeliveries,
    pendingRetries: retryTimers.size,
  };
}

/**
 * Cancel all pending retries (for graceful shutdown)
 */
function cancelRetries() {
  for (const timer of retryTimers) {
    clearTimeout(timer);
  }
  retryTimers.clear();
}

module.exports = { queueDelivery, getDeliveryStats, getQueueInfo, cancelRetries, drainQueue };
