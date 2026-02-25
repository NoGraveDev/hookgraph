/**
 * HCS Mirror Node Poller
 * Polls mirror node REST API for new messages on subscribed topics
 * Supports cycling across multiple mirror node providers
 */

const PROVIDERS = [
  { name: 'hedera-public', base: 'https://mainnet.mirrornode.hedera.com' },
  { name: 'hgraph', base: 'https://mainnet.hedera.api.hgraph.io/v1/sk_prod_b28c1e7b8411c09e170c986692c9f927eb6322a6' },
];

let providerIndex = 0;
const cooldowns = new Map();

function getProvider() {
  const now = Date.now();
  for (let i = 0; i < PROVIDERS.length; i++) {
    const idx = (providerIndex + i) % PROVIDERS.length;
    const p = PROVIDERS[idx];
    const cd = cooldowns.get(p.name);
    if (!cd || now > cd) {
      providerIndex = (idx + 1) % PROVIDERS.length;
      return p;
    }
  }
  // All on cooldown — use first anyway
  providerIndex = (providerIndex + 1) % PROVIDERS.length;
  return PROVIDERS[providerIndex];
}

function cooldownProvider(name, ms = 10000) {
  cooldowns.set(name, Date.now() + ms);
}

/**
 * Fetch new messages for a topic since a given timestamp
 */
async function fetchTopicMessages(topicId, afterTimestamp = null, limit = 100) {
  const provider = getProvider();
  let url = `${provider.base}/api/v1/topics/${topicId}/messages?limit=${limit}&order=asc`;
  if (afterTimestamp) {
    url += `&timestamp=gt:${afterTimestamp}`;
  }

  try {
    const res = await fetch(url, {
      headers: { 'Accept': 'application/json' },
      signal: AbortSignal.timeout(10000),
    });

    if (res.status === 429) {
      cooldownProvider(provider.name, 30000);
      console.warn(`[mirror] Rate limited by ${provider.name}, cooling down 30s`);
      return { messages: [], provider: provider.name };
    }

    if (!res.ok) {
      console.error(`[mirror] ${provider.name} returned ${res.status} for topic ${topicId}`);
      cooldownProvider(provider.name, 5000);
      return { messages: [], provider: provider.name };
    }

    const data = await res.json();
    return {
      messages: (data.messages || []).map(m => ({
        consensus_timestamp: m.consensus_timestamp,
        sequence_number: m.sequence_number,
        message: m.message,
        payer_account_id: m.payer_account_id,
        topic_id: topicId,
        running_hash: m.running_hash,
      })),
      provider: provider.name,
    };
  } catch (err) {
    console.error(`[mirror] Error fetching from ${provider.name}:`, err.message);
    cooldownProvider(provider.name, 5000);
    return { messages: [], provider: provider.name };
  }
}

/**
 * Look up the consensus timestamp for a given sequence number
 * Uses provider cycling instead of hardcoded endpoint
 */
async function lookupTimestamp(topicId, sequenceNumber) {
  const provider = getProvider();
  try {
    const res = await fetch(
      `${provider.base}/api/v1/topics/${topicId}/messages?limit=1&order=desc&sequencenumber=${sequenceNumber}`,
      { signal: AbortSignal.timeout(10000) }
    );
    if (res.ok) {
      const data = await res.json();
      if (data.messages && data.messages.length > 0) {
        return data.messages[0].consensus_timestamp;
      }
    }
  } catch (err) {
    console.error(`[mirror] Timestamp lookup failed for ${topicId}@${sequenceNumber}:`, err.message);
  }
  return null;
}

module.exports = { fetchTopicMessages, lookupTimestamp, getProvider, PROVIDERS };
