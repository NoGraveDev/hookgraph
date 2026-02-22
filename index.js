#!/usr/bin/env node
/**
 * HookGraph — HCS Webhook Service for Hedera
 * Subscribe to Hedera Consensus Service topics and receive webhook notifications
 */

const express = require('express');
const apiRouter = require('./src/api');
const poller = require('./src/poller');
const { pruneDeliveries } = require('./src/db');
const { getQueueInfo, cancelRetries } = require('./src/delivery');

const PORT = parseInt(process.env.PORT || '4080', 10);
const HOST = process.env.HOST || '127.0.0.1';
const PRUNE_INTERVAL_MS = 3600000; // Prune old deliveries every hour

if (!Number.isFinite(PORT) || PORT < 1 || PORT > 65535) {
  console.error(`[hookgraph] Invalid PORT: ${process.env.PORT}`);
  process.exit(1);
}

const app = express();

// Body size limit (prevent memory exhaustion)
app.use(express.json({ limit: '100kb' }));

// Trust proxy for rate limiting by IP behind reverse proxy
app.set('trust proxy', process.env.TRUST_PROXY || 1);

// Security headers
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.removeHeader('X-Powered-By');

  // CORS
  const allowedOrigins = process.env.CORS_ORIGINS;
  if (req.headers.origin) {
    if (allowedOrigins) {
      const origins = allowedOrigins.split(',').map(s => s.trim());
      if (origins.includes(req.headers.origin)) {
        res.setHeader('Access-Control-Allow-Origin', req.headers.origin);
      }
    } else {
      // Default: allow all (for development / public API)
      res.setHeader('Access-Control-Allow-Origin', req.headers.origin);
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Access-Control-Max-Age', '86400');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// Health check
app.get('/health', (req, res) => {
  res.json({
    service: 'hookgraph',
    version: '1.0.0',
    status: 'ok',
    uptime: Math.round(process.uptime()),
    memory: Math.round(process.memoryUsage().rss / 1024 / 1024) + 'MB',
    queue: getQueueInfo(),
  });
});

// Info page
app.get('/', (req, res) => {
  res.json({
    name: 'HookGraph',
    description: 'HCS Webhook Service for Hedera — Subscribe to topics, receive webhooks',
    version: '1.0.0',
    docs: '/api/v1',
    endpoints: {
      'POST /api/v1/keys': 'Create API key (no auth)',
      'GET /api/v1/account': 'View account & usage',
      'POST /api/v1/subscriptions': 'Subscribe to an HCS topic',
      'GET /api/v1/subscriptions': 'List subscriptions',
      'GET /api/v1/subscriptions/:id': 'Get subscription details',
      'PATCH /api/v1/subscriptions/:id': 'Update subscription',
      'DELETE /api/v1/subscriptions/:id': 'Delete subscription',
      'GET /api/v1/subscriptions/:id/deliveries': 'View delivery history',
      'POST /api/v1/subscriptions/:id/test': 'Send test webhook',
    },
    free_tier: { topics: 3, daily_webhooks: 500 },
  });
});

// API routes
app.use('/api/v1', apiRouter);

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// Global error handler
app.use((err, req, res, _next) => {
  if (err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'Request body too large (max 100KB)' });
  }
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'Invalid JSON in request body' });
  }
  console.error('[api] Unhandled error:', err.message);
  if (!res.headersSent) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Start server
const server = app.listen(PORT, HOST, () => {
  console.log(`
  ╔═══════════════════════════════════════╗
  ║         HookGraph v1.0.0              ║
  ║   HCS Webhook Service for Hedera      ║
  ╚═══════════════════════════════════════╝
  
  API:    http://${HOST}:${PORT}
  Health: http://${HOST}:${PORT}/health
  `);

  poller.start();
});

// Set server timeouts
server.keepAliveTimeout = 65000; // Slightly above typical LB idle timeout
server.headersTimeout = 66000;

// Periodic cleanup
const pruneTimer = setInterval(() => {
  try {
    pruneDeliveries(7);
  } catch (err) {
    console.error('[hookgraph] Prune error:', err.message);
  }
}, PRUNE_INTERVAL_MS);
pruneTimer.unref();

// Graceful shutdown
let shuttingDown = false;

function shutdown(signal) {
  if (shuttingDown) return; // Prevent double shutdown
  shuttingDown = true;

  console.log(`\n[hookgraph] ${signal} received, shutting down...`);
  poller.stop();
  cancelRetries();
  clearInterval(pruneTimer);

  server.close(() => {
    console.log('[hookgraph] Server closed');
    process.exit(0);
  });

  // Force exit after 10s if graceful shutdown hangs
  const forceExit = setTimeout(() => {
    console.error('[hookgraph] Forced exit after timeout');
    process.exit(1);
  }, 10000);
  forceExit.unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('uncaughtException', (err) => {
  console.error('[hookgraph] Uncaught exception:', err);
  shutdown('uncaughtException');
});
process.on('unhandledRejection', (err) => {
  console.error('[hookgraph] Unhandled rejection:', err);
  // Don't crash for unhandled rejections — log and continue
});
