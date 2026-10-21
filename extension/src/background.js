/* Auto Radar — service worker.
 *
 * Buffers extracted listings and ships them to the local collector. The server
 * is usually not running (laptop closed, script stopped), so anything that
 * fails to send is parked in storage and retried on an alarm. Losing a day of
 * price history to a connection refused would defeat the whole point.
 */

import * as crawler from './crawler.js';

const DEFAULTS = {
  serverUrl: 'http://127.0.0.1:8787',
  token: '',
  enabled: true,
};

const QUEUE_KEY = 'radar:queue';
const STATS_KEY = 'radar:stats';
const MAX_QUEUE = 2000;

async function settings() {
  const stored = await chrome.storage.local.get(Object.keys(DEFAULTS));
  return { ...DEFAULTS, ...stored };
}

async function bumpStats(patch) {
  const { [STATS_KEY]: stats = {} } = await chrome.storage.local.get(STATS_KEY);
  const next = { ...stats, ...patch };
  await chrome.storage.local.set({ [STATS_KEY]: next });
  return next;
}

async function post(batch, cfg) {
  const res = await fetch(`${cfg.serverUrl}/ingest`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Radar-Token': cfg.token },
    body: JSON.stringify(batch),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${await res.text().catch(() => '')}`);
  return res.json().catch(() => ({}));
}

async function enqueue(batch) {
  const { [QUEUE_KEY]: queue = [] } = await chrome.storage.local.get(QUEUE_KEY);
  queue.push(batch);
  // Drop oldest first: recent prices matter more than a stale backlog.
  const trimmed = queue.slice(-MAX_QUEUE);
  await chrome.storage.local.set({ [QUEUE_KEY]: trimmed });
  await bumpStats({ queued: trimmed.length });
}

async function flushQueue() {
  const cfg = await settings();
  if (!cfg.enabled) return;

  const { [QUEUE_KEY]: queue = [] } = await chrome.storage.local.get(QUEUE_KEY);
  if (!queue.length) return;

  const remaining = [...queue];
  while (remaining.length) {
    try {
      await post(remaining[0], cfg);
      remaining.shift();
    } catch {
      break; // still unreachable; keep the rest for the next alarm
    }
  }

  await chrome.storage.local.set({ [QUEUE_KEY]: remaining });
  await bumpStats({ queued: remaining.length, lastFlushAt: new Date().toISOString() });
}

chrome.runtime.onMessage.addListener((msg, sender, respond) => {
  if (msg?.type === 'radar:crawl-status') {
    crawler.status().then(respond);
    return true;
  }
  if (msg?.type === 'radar:crawl-config') {
    (async () => {
      if (msg.seeds !== undefined) await crawler.setSeeds(msg.seeds);
      if (msg.config) await crawler.setConfig(msg.config);
      if (msg.reset) await crawler.resetFrontier();
      respond({ ok: true, seeds: await crawler.seeds(), status: await crawler.status() });
    })();
    return true;
  }
  if (msg?.type !== 'radar:listings') return false;

  (async () => {
    // Tell the crawler the page is done before anything that might throw, so a
    // server outage cannot strand an open tab or stall the frontier.
    if (sender.tab?.id != null) {
      await crawler.onPageReported(sender.tab.id, msg.payload).catch(() => {});
    }

    const cfg = await settings();
    if (!cfg.enabled) return respond({ ok: false, reason: 'disabled' });
    if (!msg.payload.listings.length) return respond({ ok: true, skipped: 'empty' });

    try {
      const result = await post(msg.payload, cfg);
      await bumpStats({
        lastSendAt: new Date().toISOString(),
        lastError: null,
        totalSent: ((await chrome.storage.local.get(STATS_KEY))[STATS_KEY]?.totalSent || 0) +
          msg.payload.listings.length,
      });
      flushQueue(); // a working connection is the moment to drain the backlog
      respond({ ok: true, result });
    } catch (err) {
      await enqueue(msg.payload);
      await bumpStats({ lastError: String(err), lastErrorAt: new Date().toISOString() });
      respond({ ok: false, queued: true, error: String(err) });
    }
  })();

  return true; // async respond
});

chrome.alarms.create('radar:flush', { periodInMinutes: 3 });
// Beats every minute; the crawler decides for itself whether anything is due.
chrome.alarms.create('radar:crawl', { periodInMinutes: 1 });

chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === 'radar:flush') flushQueue();
  if (a.name === 'radar:crawl') crawler.tick().catch((e) => console.warn('[Auto Radar] crawl', e));
});

// A crawl tab the user closes by hand must not leave the frontier marked busy.
chrome.tabs.onRemoved.addListener(async (tabId) => {
  const { 'radar:crawl:open': open } = await chrome.storage.local.get('radar:crawl:open');
  if (open?.tabId === tabId) await chrome.storage.local.remove('radar:crawl:open');
});

chrome.runtime.onInstalled.addListener(() => chrome.storage.local.set(DEFAULTS));
chrome.runtime.onStartup.addListener(() => flushQueue());
