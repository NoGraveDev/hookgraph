const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DB_PATH = process.env.HOOKGRAPH_DB || path.join(__dirname, '..', 'data', 'hookgraph.db');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Schema
db.exec(`
  CREATE TABLE IF NOT EXISTS api_keys (
    id TEXT PRIMARY KEY,
    key_hash TEXT NOT NULL UNIQUE,
    name TEXT,
    tier TEXT DEFAULT 'free',
    created_at INTEGER DEFAULT (unixepoch()),
    topics_limit INTEGER DEFAULT 3,
    daily_webhook_limit INTEGER DEFAULT 500
  );

  CREATE TABLE IF NOT EXISTS subscriptions (
    id TEXT PRIMARY KEY,
    api_key_id TEXT NOT NULL,
    topic_id TEXT NOT NULL,
    webhook_url TEXT NOT NULL,
    secret TEXT,
    filter_json TEXT,
    active INTEGER DEFAULT 1,
    created_at INTEGER DEFAULT (unixepoch()),
    last_sequence INTEGER DEFAULT 0,
    last_timestamp TEXT,
    FOREIGN KEY (api_key_id) REFERENCES api_keys(id) ON DELETE CASCADE,
    UNIQUE(api_key_id, topic_id, webhook_url)
  );

  CREATE TABLE IF NOT EXISTS deliveries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    subscription_id TEXT NOT NULL,
    message_sequence INTEGER,
    consensus_timestamp TEXT,
    status TEXT DEFAULT 'pending',
    attempts INTEGER DEFAULT 0,
    last_attempt_at INTEGER,
    response_code INTEGER,
    created_at INTEGER DEFAULT (unixepoch()),
    FOREIGN KEY (subscription_id) REFERENCES subscriptions(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_sub_topic ON subscriptions(topic_id) WHERE active = 1;
  CREATE INDEX IF NOT EXISTS idx_del_status ON deliveries(status) WHERE status IN ('pending', 'retry');
  CREATE INDEX IF NOT EXISTS idx_del_sub ON deliveries(subscription_id);
  CREATE INDEX IF NOT EXISTS idx_del_created ON deliveries(created_at);
`);

// Add last_timestamp column if missing (migration for existing DBs)
try {
  db.exec('ALTER TABLE subscriptions ADD COLUMN last_timestamp TEXT');
} catch {
  // Column already exists
}

/**
 * Prune old delivered/dead deliveries (keep last 7 days)
 */
function pruneDeliveries(maxAgeDays = 7) {
  const cutoff = Math.floor(Date.now() / 1000) - (maxAgeDays * 86400);
  const result = db.prepare(`
    DELETE FROM deliveries WHERE status IN ('delivered', 'dead') AND created_at < ?
  `).run(cutoff);
  if (result.changes > 0) {
    console.log(`[db] Pruned ${result.changes} old deliveries`);
  }
}

module.exports = db;
module.exports.pruneDeliveries = pruneDeliveries;
