# HookGraph — Demo Video Script

**Target length:** 2–3 minutes

---

## Scene 1: Hook (0:00–0:15)

**[Screen: Terminal with a single curl command]**

> "What if getting real-time data from Hedera Consensus Service was just… one API call?"

**[The curl fires. A webhook payload appears instantly in a second terminal pane.]**

> "This is HookGraph."

---

## Scene 2: The Problem (0:15–0:35)

**[Screen: hookgraph.com landing page]**

> "Every developer building on Hedera's Consensus Service hits the same wall. You need real-time message data, but to get it, you have to build and run your own polling infrastructure — a server that watches the mirror node 24/7, handles rate limits, retries failures, and never goes down."

> "For bots and AI agents, this is even worse. They're supposed to be lightweight and autonomous — not babysitting infrastructure."

---

## Scene 3: The Solution (0:35–0:50)

> "HookGraph eliminates all of that. Subscribe to any HCS topic, give us your webhook URL, and we deliver every new message — signed, retried, and filtered — directly to your endpoint."

> "Subscribe once. Get webhooks forever."

---

## Scene 4: Live Demo — Create an API Key (0:50–1:15)

**[Screen: Terminal]**

> "Let me show you how it works. First, create an API key."

```bash
curl -X POST https://hookgraph.com/api/keys \
  -H "Content-Type: application/json" \
  -d '{"name": "demo-app"}'
```

**[Response appears with the API key, tier info, and limits]**

> "Free tier gives you 3 topics and 500 webhooks per day — enough to build and test."

---

## Scene 5: Subscribe to a Topic (1:15–1:40)

> "Now let's subscribe to a live HCS topic. I'll point the webhook at a request catcher so we can see deliveries in real time."

```bash
curl -X POST https://hookgraph.com/api/subscriptions \
  -H "Authorization: Bearer hg_..." \
  -H "Content-Type: application/json" \
  -d '{
    "topic_id": "0.0.1234567",
    "webhook_url": "https://webhook.site/my-endpoint",
    "secret": "demo-secret-123"
  }'
```

**[Response shows subscription created successfully]**

> "That's it. HookGraph is now monitoring this topic."

---

## Scene 6: Webhook Delivery (1:40–2:05)

**[Screen: Split view — terminal on left, webhook.site on right]**

> "And here they come."

**[Webhook payloads start appearing on webhook.site]**

> "Every message includes the topic ID, sequence number, consensus timestamp, and the message content. And notice the signature header — that's HMAC-SHA256, signed with the secret we provided. Your app can verify every delivery is authentic."

**[Highlight the X-HookGraph-Signature header]**

---

## Scene 7: Health & Stats (2:05–2:20)

> "You also get full visibility into the system."

```bash
curl https://hookgraph.com/health
```

**[Shows uptime, active subscriptions, provider status]**

```bash
curl https://hookgraph.com/api/stats -H "Authorization: Bearer hg_..."
```

**[Shows today's delivery count, success rate, remaining quota]**

> "Health checks, delivery stats, and full delivery history — all via the API."

---

## Scene 8: Business Model & Close (2:20–2:45)

> "HookGraph is a freemium SaaS. Free tier for builders, Pro at $29 a month for production apps, Business at $99 for heavy workloads."

> "Under the hood, we cycle across multiple mirror node providers — Hedera public, Validation Cloud, and Hgraph — so if one rate-limits, we seamlessly switch to the next."

> "Coming next: a dashboard UI, native HBAR payments, and WebSocket streaming."

**[Screen: hookgraph.com landing page]**

> "HookGraph — the webhook layer Hedera has been missing. It's live right now at hookgraph.com."

> "Built by Grave Labs."

**[End]**
