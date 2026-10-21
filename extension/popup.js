const $ = (id) => document.getElementById(id);

function say(text, isError = false) {
  const el = $('msg');
  el.textContent = text;
  el.className = isError ? 'err' : '';
}

async function loadSettings() {
  const cfg = await chrome.storage.local.get(['serverUrl', 'token']);
  $('serverUrl').value = cfg.serverUrl || 'http://127.0.0.1:8787';
  $('token').value = cfg.token || '';
}

const saveSettings = () =>
  chrome.storage.local.set({
    serverUrl: $('serverUrl').value.trim().replace(/\/$/, ''),
    token: $('token').value.trim(),
  });

async function refreshStats() {
  const { 'radar:stats': stats = {} } = await chrome.storage.local.get('radar:stats');
  $('s-queued').textContent = stats.queued ?? 0;

  const { serverUrl, token } = await chrome.storage.local.get(['serverUrl', 'token']);
  try {
    const res = await fetch(`${serverUrl}/api/summary`, { headers: { 'X-Radar-Token': token || '' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const s = await res.json();
    $('dot').className = 'dot ok';
    $('s-listings').textContent = s.listings.toLocaleString('sr-RS');
    $('s-snapshots').textContent = s.snapshots.toLocaleString('sr-RS');
    $('s-changes').textContent = s.price_changes.toLocaleString('sr-RS');
    if (stats.lastError) say('Poslednja greška: ' + stats.lastError, true);
  } catch (err) {
    $('dot').className = 'dot bad';
    say('Server nedostupan — podaci se čuvaju u redu. (' + err.message + ')', true);
  }
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function askTab(type) {
  const tab = await activeTab();
  if (!tab?.url?.includes('polovniautomobili.com')) {
    say('Otvori stranicu na polovniautomobili.com.', true);
    return null;
  }
  return chrome.tabs.sendMessage(tab.id, { type });
}

$('scan').addEventListener('click', async () => {
  await saveSettings();
  try {
    const r = await askTab('radar:scan-now');
    if (r?.ok) {
      say('Skenirano. Osvežavam…');
      setTimeout(refreshStats, 1200);
    }
  } catch {
    say('Content script nije učitan — osveži stranicu (⌘R).', true);
  }
});

$('debug').addEventListener('click', async () => {
  try {
    const r = await askTab('radar:debug');
    if (!r) return;
    if (!r.ok) return say('Greška: ' + r.error, true);
    await navigator.clipboard.writeText(JSON.stringify(r.report, null, 2));
    const n = r.report.counts.extracted;
    say(`Kopirano u clipboard — ${n} oglasa izvučeno.`);
  } catch {
    say('Content script nije učitan — osveži stranicu (⌘R).', true);
  }
});

for (const id of ['serverUrl', 'token']) {
  $(id).addEventListener('change', async () => {
    await saveSettings();
    refreshStats();
  });
}

// ------------------------------------------------------------------ crawler

function sayCrawl(text, isError = false) {
  const el = $('crawl-msg');
  el.textContent = text;
  el.className = isError ? 'err' : '';
}

const relative = (ts) => {
  if (!ts) return '—';
  const s = Math.round((ts - Date.now()) / 1000);
  if (s <= 0) return 'uskoro';
  return s < 90 ? `za ${s} s` : `za ${Math.round(s / 60)} min`;
};

async function refreshCrawl() {
  const [status, cfg, seeds] = await Promise.all([
    chrome.runtime.sendMessage({ type: 'radar:crawl-status' }),
    chrome.storage.local.get('radar:crawl:config'),
    chrome.storage.local.get('radar:crawl:seeds'),
  ]);
  const c = { intervalMinutes: 4, dailyCap: 150, ...(cfg['radar:crawl:config'] || {}) };

  $('crawl-enabled').checked = !!status.enabled;
  if (document.activeElement !== $('seeds')) {
    $('seeds').value = (seeds['radar:crawl:seeds'] || []).join('\n');
  }
  if (document.activeElement !== $('interval')) $('interval').value = c.intervalMinutes;
  if (document.activeElement !== $('cap')) $('cap').value = c.dailyCap;

  $('c-frontier').textContent = `${status.dueNow} / ${status.frontierSize}`;
  $('c-today').textContent = `${status.pagesToday} / ${status.dailyCap}`;
  $('c-next').textContent = status.busy ? 'učitava…'
    : !status.enabled ? 'isključeno'
    : status.pagesToday >= status.dailyCap ? 'limit za danas'
    : relative(status.nextRunAt);

  if (status.lastError) sayCrawl(status.lastError, true);
}

$('crawl-save').addEventListener('click', async () => {
  const urls = $('seeds').value.split('\n');
  const res = await chrome.runtime.sendMessage({
    type: 'radar:crawl-config',
    seeds: urls,
    config: {
      enabled: $('crawl-enabled').checked,
      intervalMinutes: Math.max(1, Number($('interval').value) || 4),
      dailyCap: Math.max(1, Number($('cap').value) || 150),
    },
  });
  const dropped = urls.filter((u) => u.trim()).length - res.seeds.length;
  sayCrawl(dropped > 0
    ? `Sačuvano. ${dropped} URL odbačeno (nije polovniautomobili.com ili je zabranjen).`
    : `Sačuvano — ${res.seeds.length} pretraga.`, dropped > 0);
  refreshCrawl();
});

$('crawl-reset').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'radar:crawl-config', reset: true });
  sayCrawl('Red obilaska resetovan na početne pretrage.');
  refreshCrawl();
});

$('crawl-enabled').addEventListener('change', async () => {
  await chrome.runtime.sendMessage({
    type: 'radar:crawl-config',
    config: { enabled: $('crawl-enabled').checked },
  });
  refreshCrawl();
});

loadSettings().then(refreshStats);
refreshCrawl();
setInterval(refreshCrawl, 5000);
