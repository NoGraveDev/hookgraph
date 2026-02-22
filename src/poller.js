/**
 * HCS Topic Poller
 * Polls subscribed topics and dispatches new messages to webhook delivery
 */

const db = require('./db');
const { fetchTopicMessages, lookupTimestamp } = require('./mirror');
const { queueDelivery } = require('./delivery');

const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MS || '5000');

// Track last seen timestamp per topic (shared across all subs for that topic)
const topicCursors = new Map();

function loadCursors() {
  const rows = db.prepare(`
    SELECT topic_id, MAX(last_sequence) as max_seq, MAX(last_timestamp) as max_ts
    FROM subscriptions WHERE active = 1 
    GROUP BY topic_id
  `).all();
  
  for (const row of rows) {
    topicCursors.set(row.topic_id, {
      lastSequence: row.max_seq || 0,
      lastTimestamp: row.max_ts || null,
    });
  }
  console.log(`[poller] Loaded cursors for ${topicCursors.size} topics`);
}

function getActiveTopics() {
  return db.prepare(
    'SELECT DISTINCT topic_id FROM subscriptions WHERE active = 1'
  ).all().map(r => r.topic_id);
}

function getSubscriptionsForTopic(topicId) {
  const subs = db.prepare(
    'SELECT * FROM subscriptions WHERE topic_id = ? AND active = 1'
  ).all(topicId);

  // Pre-parse filters once (not per message)
  return subs.map(sub => ({
    ...sub,
    _parsedFilter: sub.filter_json ? (() => { try { return JSON.parse(sub.filter_json); } catch { return null; } })() : null,
  }));
}

async function pollTopic(topicId) {
  const cursor = topicCursors.get(topicId) || { lastSequence: 0, lastTimestamp: null };
  
  // Resolve timestamp from sequence if needed (uses provider cycling)
  if (cursor.lastSequence > 0 && !cursor.lastTimestamp) {
    const ts = await lookupTimestamp(topicId, cursor.lastSequence);
    if (ts) {
      cursor.lastTimestamp = ts;
      topicCursors.set(topicId, cursor);
    }
  }

  const { messages } = await fetchTopicMessages(topicId, cursor.lastTimestamp, 100);
  if (messages.length === 0) return 0;

  const subs = getSubscriptionsForTopic(topicId);
  if (subs.length === 0) return 0;

  let delivered = 0;

  for (const msg of messages) {
    if (msg.sequence_number <= cursor.lastSequence) continue;

    // Decode base64
    let decodedMessage = '';
    try {
      decodedMessage = Buffer.from(msg.message, 'base64').toString('utf-8');
    } catch {
      decodedMessage = msg.message;
    }

    // Try JSON parse
    let parsedMessage = decodedMessage;
    try {
      parsedMessage = JSON.parse(decodedMessage);
    } catch {}

    const payload = {
      event: 'hcs.message',
      topic_id: topicId,
      sequence_number: msg.sequence_number,
      consensus_timestamp: msg.consensus_timestamp,
      payer_account_id: msg.payer_account_id,
      message: parsedMessage,
      raw_message_base64: msg.message,
      running_hash: msg.running_hash,
    };

    for (const sub of subs) {
      // Per-subscription sequence dedup
      if (msg.sequence_number <= sub.last_sequence) continue;

      // Apply pre-parsed filters
      if (sub._parsedFilter) {
        const f = sub._parsedFilter;
        if (f.payer_account_id && f.payer_account_id !== msg.payer_account_id) continue;
        if (f.contains && typeof decodedMessage === 'string' && !decodedMessage.includes(f.contains)) continue;
      }

      queueDelivery(sub, payload);
      delivered++;
    }

    cursor.lastSequence = msg.sequence_number;
    cursor.lastTimestamp = msg.consensus_timestamp;
  }

  topicCursors.set(topicId, cursor);

  // Persist cursor to DB (both sequence and timestamp)
  if (messages.length > 0) {
    const lastMsg = messages[messages.length - 1];
    db.prepare(`
      UPDATE subscriptions SET last_sequence = ?, last_timestamp = ?
      WHERE topic_id = ? AND active = 1 AND last_sequence < ?
    `).run(lastMsg.sequence_number, lastMsg.consensus_timestamp, topicId, lastMsg.sequence_number);
  }

  return delivered;
}

let polling = false;
let pollTimer = null;

async function pollCycle() {
  if (polling) return;
  polling = true;

  try {
    const topics = getActiveTopics();
    for (const topicId of topics) {
      try {
        const count = await pollTopic(topicId);
        if (count > 0) {
          console.log(`[poller] ${topicId}: ${count} webhook(s) queued`);
        }
      } catch (err) {
        console.error(`[poller] Error polling ${topicId}:`, err.message);
      }
    }
  } finally {
    polling = false;
  }
}

function start() {
  loadCursors();
  console.log(`[poller] Starting poll loop every ${POLL_INTERVAL_MS}ms`);
  pollCycle();
  pollTimer = setInterval(pollCycle, POLL_INTERVAL_MS);
}

function stop() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

module.exports = { start, stop, pollCycle };
