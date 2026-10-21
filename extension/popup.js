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

loadSettings().then(refreshStats);
