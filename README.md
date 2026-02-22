<![CDATA[<div align="center">

# 🪝 HookGraph

**Real-time webhooks for Hedera Consensus Service**

[![Live](https://img.shields.io/badge/status-live-brightgreen)](https://hookgraph.com)
[![Hedera](https://img.shields.io/badge/built%20on-Hedera-8259ef)](https://hedera.com)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18-green)](https://nodejs.org)

*Subscribe to any HCS topic. Get webhook notifications. That's it.*

[hookgraph.com](https://hookgraph.com) · [API Docs](#api-reference) · [Pricing](#pricing)

</div>

---

## What is HookGraph?

HookGraph is a **webhook-as-a-service** for Hedera Consensus Service (HCS). It monitors HCS topics and delivers new messages to your endpoint in real time — signed, verified, and retried automatically.

**Before HookGraph:** You spin up a server, poll the mirror node, handle rate limits, manage state, implement retries, and pray it stays up.

**After HookGraph:** One API call. Webhooks flow. You build your app.

## Why It Matters

There is no standalone HCS webhook service in the Hedera ecosystem. Developers building dApps, bots, agents, or marketplaces that need real-time consensus data are forced to build and maintain their own polling infrastructure. HookGraph eliminates that entirely.

## Architecture

```
┌──────────────┐     ┌──────────────────┐     ┌─────────────────┐
│  Your App    │────▶│   HookGraph API  │     │  Hedera Mirror   │
│              │     │   (Express)      │     │  Nodes           │
│  POST /keys  │     ├──────────────────┤     │  ┌────────────┐ │
│  POST /subs  │     │  SQLite DB       │     │  │ Public     │ │
│              │     │  (keys, subs,    │◀────│  │ Validation │ │
│  ◀── webhook │     │   deliveries)    │     │  │ Cloud      │ │
│     payload  │     ├──────────────────┤     │  │ Hgraph     │ │
│              │     │  Poller Engine   │─────│  └────────────┘ │
│              │     │  (provider cycle) │     └─────────────────┘
└──────────────┘     ├──────────────────┤
                     │  Delivery Engine │──▶  Your webhook URL
                     │  (HMAC, retry,   │     (signed + verified)
                     │   queue, limits) │
                     └──────────────────┘
```

## Features

| Feature | Description |
|---------|-------------|
| **HMAC-SHA256 Signatures** | Every webhook delivery is signed with your secret — verify authenticity on your end |
| **Exponential Backoff Retry** | Failed deliveries retry at 5s → 15s → 1m → 5m → 15m with up to 5 attempts |
| **Message Filtering** | Filter by sequence number range, sender account, or message content |
| **Provider Cycling** | Automatically rotates across Hedera public, Validation Cloud, and Hgraph mirror nodes |
| **SSRF Protection** | Private/internal IPs are blocked — webhook URLs are validated against RFC 1918 ranges |
| **Rate Limiting** | API key creation rate-limited per IP; daily webhook limits per tier |
| **Delivery Tracking** | Full delivery history with status codes, timestamps, and retry counts |
| **Zero Dependencies** | Pure Node.js + Express + better-sqlite3. No ORMs, no frameworks, no bloat |

## Quick Start

### 1. Create an API Key

```bash
curl -X POST https://hookgraph.com/api/keys \
  -H "Content-Type: application/json" \
  -d '{"name": "my-app"}'
```

```json
{
  "api_key": "hg_a1b2c3d4e5f6...",
  "name": "my-app",
  "tier": "free",
  "daily_webhook_limit": 500,
  "max_subscriptions": 3
}
```

> ⚠️ Save your API key — it's shown only once.

### 2. Subscribe to an HCS Topic

```bash
curl -X POST https://hookgraph.com/api/subscriptions \
  -H "Authorization: Bearer hg_a1b2c3d4e5f6..." \
  -H "Content-Type: application/json" \
  -d '{
    "topic_id": "0.0.1234567",
    "webhook_url": "https://your-app.com/webhook",
    "secret": "your-hmac-secret"
  }'
```

### 3. Receive Webhooks

HookGraph will POST to your URL whenever a new message appears on the topic:

```json
{
  "topic_id": "0.0.1234567",
  "sequence_number": 42,
  "consensus_timestamp": "1708642800.123456789",
  "message": "base64-encoded-content",
  "payer_account_id": "0.0.98765",
  "running_hash": "..."
}
```

Verify the signature:

```javascript
const crypto = require('crypto');
const expected = crypto.createHmac('sha256', secret)
  .update(JSON.stringify(body))
  .digest('hex');
const valid = req.headers['x-hookgraph-signature'] === expected;
```

## API Reference

**Base URL:** `https://hookgraph.com/api`

All authenticated endpoints require `Authorization: Bearer <api_key>`.

### Health

```
GET /health
```

```bash
curl https://hookgraph.com/health
```

Returns service status, uptime, active subscriptions, and current mirror node provider.

---

### API Keys

#### Create Key

```
POST /api/keys
```

```bash
curl -X POST https://hookgraph.com/api/keys \
  -H "Content-Type: application/json" \
  -d '{"name": "my-app"}'
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | No | Friendly name (max 100 chars) |

#### Get Key Info

```
GET /api/keys/me
```

```bash
curl https://hookgraph.com/api/keys/me \
  -H "Authorization: Bearer hg_..."
```

Returns tier, limits, usage stats, and subscription count.

---

### Subscriptions

#### Create Subscription

```
POST /api/subscriptions
```

```bash
curl -X POST https://hookgraph.com/api/subscriptions \
  -H "Authorization: Bearer hg_..." \
  -H "Content-Type: application/json" \
  -d '{
    "topic_id": "0.0.1234567",
    "webhook_url": "https://example.com/hook",
    "secret": "my-secret-key",
    "filter": {"min_sequence": 100}
  }'
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `topic_id` | string | Yes | HCS topic ID (e.g., `0.0.1234567`) |
| `webhook_url` | string | Yes | HTTPS endpoint to receive webhooks |
| `secret` | string | No | HMAC-SHA256 signing secret |
| `filter` | object | No | Message filtering rules |

#### List Subscriptions

```
GET /api/subscriptions
```

```bash
curl https://hookgraph.com/api/subscriptions \
  -H "Authorization: Bearer hg_..."
```

#### Delete Subscription

```
DELETE /api/subscriptions/:id
```

```bash
curl -X DELETE https://hookgraph.com/api/subscriptions/sub_abc123 \
  -H "Authorization: Bearer hg_..."
```

---

### Deliveries

#### Get Delivery History

```
GET /api/deliveries?subscription_id=:id&limit=50
```

```bash
curl "https://hookgraph.com/api/deliveries?subscription_id=sub_abc123&limit=20" \
  -H "Authorization: Bearer hg_..."
```

#### Get Delivery Stats

```
GET /api/stats
```

```bash
curl https://hookgraph.com/api/stats \
  -H "Authorization: Bearer hg_..."
```

Returns today's delivery count, success/failure rates, and remaining quota.

## Pricing

| | **Free** | **Pro** | **Business** |
|---|----------|---------|-------------|
| **Price** | $0 | $29/mo | $99/mo |
| **Topics** | 3 | 25 | Unlimited |
| **Webhooks/day** | 500 | 10,000 | 100,000 |
| **Retry attempts** | 3 | 5 | 5 + priority queue |
| **Support** | Community | Email | Priority |

## Tech Stack

- **Runtime:** Node.js (≥18)
- **Framework:** Express
- **Database:** SQLite via better-sqlite3
- **Data Source:** Hedera Mirror Node REST API
- **Hosting:** Railway
- **Domain:** Cloudflare DNS

## Self-Hosting

```bash
git clone https://github.com/NoGraveDev/hookgraph.git
cd hookgraph
npm install
npm start
```

The server starts on port `8080` (or `$PORT`). SQLite database is created automatically at `./data/hookgraph.db`.

## Built By

**[Grave Labs](https://github.com/NoGraveDev)** — Solo builder, shipping infrastructure for the Hedera ecosystem.

---

<div align="center">

*HookGraph — Subscribe once, get webhooks forever.*

</div>
]]>