# HookGraph — Hackathon Submission

## 🏷️ Track: Theme 1 — AI & Agents

---

## The Problem

Every developer building on Hedera Consensus Service faces the same infrastructure burden: **getting real-time HCS data into their application.**

Today, if you want to know when a new message hits an HCS topic, you must:

1. Run a persistent server that polls the mirror node
2. Handle rate limiting, pagination, and state management
3. Build retry logic for failures
4. Monitor uptime 24/7
5. Scale as your topic count grows

This is undifferentiated heavy lifting. Every team rebuilds the same plumbing — and most do it poorly. Autonomous agents and bots have it even worse: they need always-on consensus data but shouldn't need always-on infrastructure.

## The Solution

**HookGraph** is a hosted webhook service for Hedera Consensus Service.

Subscribe to any HCS topic with a single API call. HookGraph monitors the topic and delivers every new message to your webhook URL — signed with HMAC-SHA256, retried with exponential backoff, and filtered to your specifications.

**Subscribe once. Get webhooks forever.**

🌐 **Live now:** [hookgraph.com](https://hookgraph.com)

## How It Uses Hedera

HookGraph is purpose-built for the Hedera ecosystem:

- **Polls HCS mirror nodes** (Hedera public, Validation Cloud, Hgraph) for new topic messages
- **Delivers HCS message data** — sequence number, consensus timestamp, payer account, message content — via HTTP webhooks
- **Signs every payload** with HMAC-SHA256 so recipients can cryptographically verify the data originated from HookGraph
- **Cycles across mirror node providers** to maximize uptime and avoid rate limits

HookGraph doesn't compete with the mirror node — it makes it accessible. It turns a pull-based API into a push-based service.

## Why Theme 1: AI & Agents

Autonomous agents are the future of Hedera. But agents that need consensus data currently have two options:

1. **Run their own polling infrastructure** — defeating the purpose of being lightweight and autonomous
2. **Don't use HCS** — missing out on Hedera's most powerful primitive

HookGraph is the missing link. An AI agent can register a webhook in one API call and immediately start receiving real-time consensus data. No server to run. No state to manage. No infrastructure to maintain.

**HookGraph makes HCS agent-ready.**

Use cases for agents:
- **Trading bots** reacting to consensus-ordered market data
- **Governance agents** monitoring DAO proposals and votes
- **Notification agents** alerting users when specific topics update
- **Data pipeline agents** indexing HCS data into external systems
- **Multi-agent systems** coordinating via HCS topics with webhook triggers

## Technical Innovation

### Provider Cycling
HookGraph rotates across multiple mirror node providers (Hedera public, Validation Cloud, Hgraph). When one provider rate-limits or errors, it automatically cools down that provider and switches — ensuring continuous message delivery without manual intervention.

### Intelligent Retry
Failed webhook deliveries retry with exponential backoff: 5s → 15s → 1m → 5m → 15m. Each attempt is logged with status codes and response times. Concurrent delivery is capped at 10 to prevent overwhelming recipient servers.

### SSRF Protection
Webhook URLs are validated against RFC 1918 private ranges, localhost, link-local, and IPv6 internal addresses. Credentials in URLs are rejected. This prevents attackers from using HookGraph as an SSRF proxy.

### Zero-Dependency Architecture
The entire service runs on Node.js, Express, and SQLite. No ORMs, no message queues, no Redis, no Kafka. This keeps operational complexity minimal and deployment fast — the whole thing starts in under a second.

## Business Model

HookGraph is a **freemium SaaS** with infrastructure-grade pricing:

| Tier | Price | Topics | Webhooks/day |
|------|-------|--------|-------------|
| Free | $0 | 3 | 500 |
| Pro | $29/mo | 25 | 10,000 |
| Business | $99/mo | Unlimited | 100,000 |

Infrastructure services generate **recurring revenue** because the need never goes away. As long as an application needs HCS data, it needs HookGraph.

**Market:** Every Hedera dApp, wallet, marketplace, bot, and autonomous agent that consumes HCS data is a potential customer. As the Hedera ecosystem grows, so does HookGraph's addressable market.

## What's Built

✅ Full REST API (keys, subscriptions, deliveries, stats)
✅ HMAC-SHA256 webhook signing
✅ Exponential backoff retry (5 attempts)
✅ Provider cycling across mirror nodes
✅ SSRF protection
✅ Rate limiting (API key creation, daily webhook quotas)
✅ Delivery tracking and history
✅ Health monitoring endpoint
✅ Live in production at [hookgraph.com](https://hookgraph.com)

## What's Next

- 📊 **Dashboard UI** — Visual management of keys, subscriptions, and delivery logs
- 💰 **HBAR Payments** — Pay for HookGraph with native HBAR tokens
- ⚡ **WebSocket Streaming** — Real-time streaming alternative to webhooks
- 🔌 **Topic Discovery** — Browse and subscribe to popular HCS topics
- 🏛️ **HBAR Foundation Grant** — Apply for ecosystem funding to accelerate development

## Team

**Grave Labs** — Solo builder shipping developer infrastructure for the Hedera ecosystem.

- GitHub: [NoGraveDev](https://github.com/NoGraveDev)
- Live: [hookgraph.com](https://hookgraph.com)

---

*HookGraph: The webhook layer Hedera has been missing.*
