/* Auto Radar — crawler.
 *
 * Walks your saved searches on a schedule, one page at a time, in a background
 * tab of your own Chrome. No headless browser, no TLS impersonation, no
 * challenge solving — it is the same browser you use by hand, so there is
 * nothing to circumvent and nothing to break when the site changes its
 * protection.
 *
 * The pace is the point. Coverage is supposed to accumulate over weeks:
 * breadth first across your seed searches, then deeper into pagination, then
 * back round to revisit pages whose prices may have moved. One page every few
 * minutes gets there without ever looking like a crawl.
 *
 * Frontier entries live in chrome.storage, not memory, because MV3 kills the
 * service worker between alarms.
 */

const FRONTIER = 'radar:crawl:frontier';
const STATS = 'radar:crawl:stats';
const OPEN_TAB = 'radar:crawl:open';
const SEEDS = 'radar:crawl:seeds';
const CONFIG = 'radar:crawl:config';

export const DEFAULT_CONFIG = {
  enabled: false,          // opt in explicitly; never crawls just because it is installed
  intervalMinutes: 4,      // average gap between page loads
  jitter: 0.4,             // ±40% so the rhythm is not machine-regular
  dailyCap: 150,           // hard stop per calendar day
  revisitHours: 24,        // how stale a page must be before it is worth re-reading
  maxDepth: 15,            // pagination pages per seed search
  tabTimeoutMs: 45_000,    // give up on a page that never reports
};

// From the site's robots.txt. Allowed paths are not enumerated — anything not
// listed here is fair game, which is how robots.txt is meant to be read.
const DISALLOWED = [
  '/login', '/registracija', '/registracija-dilera', '/registracija-uspesna',
  '/uspesna-registracija', '/aktivacija-naloga', '/promena-lozinke', '/logout',
  '/uspesno-placanje-karticom/', '/neuspesno-placanje-karticom/',
  '/placanje-kreditnom-karticom/', '/provera-placanja-karticom/',
  '/detalji-oglasa-pdf/', '/neaktivan-oglas/', '/api/', '/oglas/uredi/',
  '/auto-vesti-related/', '/pretraga/minimalna/', '/ClassifiedDetails/contract/',
];

const nowMs = () => Date.now();
const todayStamp = () => new Date().toISOString().slice(0, 10);

async function get(key, fallback) {
  const o = await chrome.storage.local.get(key);
  return o[key] ?? fallback;
}
const set = (key, value) => chrome.storage.local.set({ [key]: value });

export async function config() {
  return { ...DEFAULT_CONFIG, ...(await get(CONFIG, {})) };
}
export async function setConfig(patch) {
  await set(CONFIG, { ...(await get(CONFIG, {})), ...patch });
}

export function isAllowed(url) {
  let u;
  try { u = new URL(url); } catch { return false; }
  if (!/(^|\.)polovniautomobili\.com$/.test(u.hostname)) return false;
  if (u.protocol !== 'https:') return false;
  return !DISALLOWED.some((p) => u.pathname.startsWith(p));
}

/** Strip the volatile bits so the same search is one frontier entry. */
function canonical(url) {
  const u = new URL(url);
  u.hash = '';
  for (const junk of ['utm_source', 'utm_medium', 'utm_campaign', 'fbclid']) {
    u.searchParams.delete(junk);
  }
  u.searchParams.sort();
  return u.href;
}

// ------------------------------------------------------------------ seeds

export async function seeds() {
  return get(SEEDS, []);
}

/** Replace the seed list and fold the new ones into the frontier. */
export async function setSeeds(urls) {
  const clean = [...new Set(urls.map((s) => s.trim()).filter(Boolean))].filter(isAllowed);
  await set(SEEDS, clean);

  const frontier = await get(FRONTIER, []);
  const known = new Set(frontier.map((f) => f.url));
  for (const url of clean) {
    const c = canonical(url);
    if (known.has(c)) continue;
    known.add(c); // two seeds can canonicalise to the same page — keep one
    frontier.push({ url: c, due: 0, depth: 1, seed: c, seen: 0, fails: 0 });
  }
  await set(FRONTIER, frontier);
  return clean;
}

export async function enqueue(url, { depth = 1, seed = null } = {}) {
  if (!isAllowed(url)) return false;
  const c = canonical(url);
  const frontier = await get(FRONTIER, []);
  if (frontier.some((f) => f.url === c)) return false;
  frontier.push({ url: c, due: 0, depth, seed, seen: 0, fails: 0 });
  await set(FRONTIER, frontier);
  return true;
}

// ------------------------------------------------------------------ status

export async function status() {
  const [cfg, frontier, stats, open] = await Promise.all([
    config(), get(FRONTIER, []), get(STATS, {}), get(OPEN_TAB, null),
  ]);
  const today = stats.day === todayStamp() ? (stats.pagesToday || 0) : 0;
  return {
    enabled: cfg.enabled,
    frontierSize: frontier.length,
    dueNow: frontier.filter((f) => f.due <= nowMs()).length,
    pagesToday: today,
    dailyCap: cfg.dailyCap,
    nextRunAt: stats.nextRunAt || null,
    lastUrl: stats.lastUrl || null,
    lastError: stats.lastError || null,
    busy: !!open,
  };
}

export async function resetFrontier() {
  await chrome.storage.local.remove([FRONTIER, OPEN_TAB]);
  await setSeeds(await seeds());
}

// ------------------------------------------------------------------- crawl

function scheduleNext(cfg) {
  const spread = 1 + (Math.random() * 2 - 1) * cfg.jitter;
  return nowMs() + cfg.intervalMinutes * 60_000 * spread;
}

/** Close a tab we opened that never reported back. */
async function reapStaleTab(cfg) {
  const open = await get(OPEN_TAB, null);
  if (!open) return;
  if (nowMs() - open.openedAt < cfg.tabTimeoutMs) return;

  try { await chrome.tabs.remove(open.tabId); } catch { /* already gone */ }
  await chrome.storage.local.remove(OPEN_TAB);

  const frontier = await get(FRONTIER, []);
  const entry = frontier.find((f) => f.url === open.url);
  if (entry) {
    entry.fails = (entry.fails || 0) + 1;
    // Back off hard on a page that keeps failing rather than hammering it.
    entry.due = nowMs() + Math.min(entry.fails, 6) * 30 * 60_000;
    await set(FRONTIER, frontier);
  }
  const stats = await get(STATS, {});
  await set(STATS, { ...stats, lastError: `nema odgovora: ${open.url}` });
}

/**
 * One scheduler beat. Called from the alarm; decides whether anything is due
 * and, if so, opens exactly one page.
 */
export async function tick() {
  const cfg = await config();
  await reapStaleTab(cfg);
  if (!cfg.enabled) return { skipped: 'disabled' };

  const open = await get(OPEN_TAB, null);
  if (open) return { skipped: 'busy' };      // never more than one tab at a time

  const stats = await get(STATS, {});
  const day = todayStamp();
  const pagesToday = stats.day === day ? (stats.pagesToday || 0) : 0;
  if (pagesToday >= cfg.dailyCap) return { skipped: 'daily-cap' };
  if (stats.nextRunAt && nowMs() < stats.nextRunAt) return { skipped: 'not-yet' };

  const frontier = await get(FRONTIER, []);
  const dueList = frontier.filter((f) => f.due <= nowMs());
  if (!dueList.length) {
    await set(STATS, { ...stats, day, pagesToday, nextRunAt: scheduleNext(cfg) });
    return { skipped: 'nothing-due' };
  }

  // Shallow pages first: page 1 of every search beats page 9 of one of them.
  dueList.sort((a, b) => a.depth - b.depth || a.due - b.due);
  const target = dueList[0];

  let tab;
  try {
    tab = await chrome.tabs.create({ url: target.url, active: false });
  } catch (err) {
    await set(STATS, { ...stats, day, pagesToday, lastError: String(err), nextRunAt: scheduleNext(cfg) });
    return { error: String(err) };
  }

  await set(OPEN_TAB, { tabId: tab.id, url: target.url, openedAt: nowMs() });
  await set(STATS, {
    ...stats, day, pagesToday: pagesToday + 1,
    lastUrl: target.url, lastError: null, nextRunAt: scheduleNext(cfg),
  });
  return { opened: target.url };
}

/**
 * A crawled page reported in. Marks it done, closes the tab, and folds the
 * next page of that search into the frontier.
 */
export async function onPageReported(tabId, payload) {
  const open = await get(OPEN_TAB, null);
  if (!open || open.tabId !== tabId) return false;   // user's own browsing, leave it alone

  const cfg = await config();
  await chrome.storage.local.remove(OPEN_TAB);
  try { await chrome.tabs.remove(tabId); } catch { /* user may have closed it */ }

  const frontier = await get(FRONTIER, []);
  const entry = frontier.find((f) => f.url === open.url);
  if (entry) {
    entry.seen = (entry.seen || 0) + 1;
    entry.fails = 0;
    entry.lastSeenAt = nowMs();
    entry.lastCount = payload?.listings?.length ?? 0;
    // Revisit later: this is how price changes get noticed at all.
    entry.due = nowMs() + cfg.revisitHours * 3600_000;
  }

  const next = payload?.pagination?.next_url;
  const depth = (entry?.depth ?? 1) + 1;
  if (next && depth <= cfg.maxDepth && isAllowed(next)) {
    const c = canonical(next);
    if (!frontier.some((f) => f.url === c)) {
      frontier.push({ url: c, due: 0, depth, seed: entry?.seed ?? open.url, seen: 0, fails: 0 });
    }
  }

  await set(FRONTIER, frontier);
  return true;
}
