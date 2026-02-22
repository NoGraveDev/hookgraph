# HookGraph

**HCS Webhook Service for Hedera** — Subscribe to Hedera Consensus Service topics and receive HTTP webhook notifications.

The only standalone HCS-to-webhook service on Hedera. No WebSocket connections. No gRPC streams. No SDK dependency. Just simple HTTP POST webhooks.

## Why

Hedera's Consensus Service (HCS) is a powerful pub/sub messaging layer, but consuming messages today requires either:
- A persistent gRPC stream via the Hedera SDK
- A WebSocket subscription via a paid provider
- Polling the mirror node REST API yourself

HookGraph eliminates all of that. Subscribe to a topic, give us a URL, and we POST messages to you as they arrive. Works with any language, any platform, any serverless function.

## Features

- **Simple REST API** — Create API key, subscribe to topics, receive webhooks
- **HMAC-SHA256 Signatures** — Verify webhook authenticity with per-subscription secrets
- **Retry with Exponential Backoff** — 5 attempts (5s → 15s → 1m → 5m → 15m)
- **Message Filtering** — Filter by payer account ID or message content
- **Provider Cycling** — Round-robin across mirror node providers to maximize throughput
- **Security Hardened** — SSRF protection, rate limiting, body size limits, secret redaction
- **Free Tier** — 3 topics, 500 webhooks/day, $0

## Quick Start

```bash
# Install & run
npm install
npm start

# Create an API key
curl -X POST http://localhost:4080/api/v1/keys \
  -H "Content-Type: application/json" \
  -d '{"name": "my-app"}'

# Subscribe to an HCS topic
curl -X POST http://localhost:4080/api/v1/subscriptions \
  -H "Authorization: Bearer hg_your_api_key_here" \
  -H "Content-Type: application/json" \
  -d '{
    "topic_id": "0.0.12345",
    "webhook_url": "https://your-app.com/webhook"
  }'
```

## API Endpoints

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| POST | `/api/v1/keys` | No | Create API key |
| GET | `/api/v1/account` | Yes | View account & usage |
| POST | `/api/v1/subscriptions` | Yes | Subscribe to HCS topic |
| GET | `/api/v1/subscriptions` | Yes | List subscriptions |
| GET | `/api/v1/subscriptions/:id` | Yes | Subscription details |
| PATCH | `/api/v1/subscriptions/:id` | Yes | Update subscription |
| DELETE | `/api/v1/subscriptions/:id` | Yes | Delete subscription |
| GET | `/api/v1/subscriptions/:id/deliveries` | Yes | Delivery history |
| POST | `/api/v1/subscriptions/:id/test` | Yes | Send test webhook |
| GET | `/health` | No | Health check |

## Webhook Payload

```json
{
  "event": "hcs.message",
  "topic_id": "0.0.12345",
  "sequence_number": 42,
  "consensus_timestamp": "1234567890.123456789",
  "payer_account_id": "0.0.98765",
  "message": { "your": "decoded message" },
  "raw_message_base64": "base64encodedmessage",
  "running_hash": "..."
}
```

### Webhook Headers

| Header | Description |
|--------|-------------|
| `X-HookGraph-Signature` | `sha256=<hmac>` — HMAC-SHA256 of the JSON body using your subscription secret |
| `X-HookGraph-Topic` | Topic ID |
| `X-HookGraph-Sequence` | Message sequence number |
| `X-HookGraph-Timestamp` | Consensus timestamp |
| `X-HookGraph-Delivery-Id` | Unique delivery ID |

### Verifying Signatures

```javascript
const crypto = require('crypto');

function verifyWebhook(body, signature, secret) {
  const expected = crypto.createHmac('sha256', secret).update(body).digest('hex');
  return signature === `sha256=${expected}`;
}
```

## Message Filters

Subscribe with optional filters to only receive matching messages:

```json
{
  "topic_id": "0.0.12345",
  "webhook_url": "https://your-app.com/webhook",
  "filters": {
    "payer_account_id": "0.0.98765",
    "contains": "keyword"
  }
}
```

## Configuration

| Env Variable | Default | Description |
|-------------|---------|-------------|
| `PORT` | `4080` | API server port |
| `HOST` | `127.0.0.1` | Bind address |
| `POLL_INTERVAL_MS` | `5000` | Mirror node poll interval |
| `HOOKGRAPH_DB` | `./data/hookgraph.db` | SQLite database path |
| `NODE_ENV` | — | Set to `test` to disable SSRF checks |

## Architecture

```
Mirror Node(s) ──poll──▶ Poller ──queue──▶ Delivery Engine ──POST──▶ Your Webhook
     │                     │                      │
     ▼                     ▼                      ▼
  Provider            SQLite DB              Retry Queue
  Cycling          (subscriptions,         (exponential
                    deliveries)              backoff)
```

## Security

- **SSRF Protection** — Webhook URLs cannot target private/internal IPs
- **Rate Limiting** — 5 API key creations per IP per hour
- **Body Size Limit** — 100KB max request body
- **Secret Redaction** — Webhook secrets shown only at creation, never in GET responses
- **Daily Limits** — Free tier capped at 500 webhook deliveries per day
- **Queue Cap** — 10,000 max queued deliveries to prevent memory exhaustion
- **Delivery Pruning** — Old deliveries auto-cleaned after 7 days

## Tech Stack

- **Runtime:** Node.js 18+
- **Framework:** Express
- **Database:** SQLite (better-sqlite3, WAL mode)
- **Data Source:** Hedera Mirror Node REST API

## License

MIT
