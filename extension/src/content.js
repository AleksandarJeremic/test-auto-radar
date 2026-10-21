/* Auto Radar — content script.
 *
 * Reads only pages you open yourself. It never navigates, never fetches, and
 * never opens tabs: the browsing is yours, this just writes down what was on
 * screen. Classifieds hydrate progressively and paginate without a reload, so
 * we re-scan on settled DOM mutations rather than once on load.
 */

(() => {
  if (window.__autoRadarAttached) return;
  window.__autoRadarAttached = true;

  const SETTLE_MS = 600;
  const MAX_SCANS = 40;

  let scans = 0;
  let timer = null;
  const sent = new Set(); // `${id}@${price}@${mileage}` — avoids re-posting no-ops

  function fingerprint(r) {
    return `${r.external_id}@${r.price ?? ''}@${r.mileage ?? ''}`;
  }

  function scanAndSend(reason) {
    if (scans >= MAX_SCANS) return;
    scans += 1;

    let payload;
    try {
      payload = Radar.scan();
    } catch (err) {
      console.warn('[Auto Radar] scan failed', err);
      return;
    }

    const fresh = payload.listings.filter((r) => {
      const fp = fingerprint(r);
      if (sent.has(fp)) return false;
      sent.add(fp);
      return true;
    });

    if (!fresh.length) return;

    chrome.runtime.sendMessage(
      { type: 'radar:listings', payload: { ...payload, listings: fresh, reason } },
      () => void chrome.runtime.lastError, // popup closed / worker asleep is fine
    );
  }

  function schedule(reason) {
    clearTimeout(timer);
    timer = setTimeout(() => scanAndSend(reason), SETTLE_MS);
  }

  schedule('load');

  new MutationObserver(() => schedule('mutation')).observe(document.body, {
    childList: true,
    subtree: true,
  });

  // SPA navigation keeps the document, so reset the per-page dedupe set.
  let lastPath = location.pathname + location.search;
  setInterval(() => {
    const path = location.pathname + location.search;
    if (path === lastPath) return;
    lastPath = path;
    sent.clear();
    scans = 0;
    schedule('navigation');
  }, 1000);

  chrome.runtime.onMessage.addListener((msg, _sender, respond) => {
    if (msg?.type === 'radar:scan-now') {
      sent.clear();
      scans = 0;
      scanAndSend('manual');
      respond({ ok: true });
    }
    if (msg?.type === 'radar:debug') {
      try {
        respond({ ok: true, report: Radar.debugReport() });
      } catch (err) {
        respond({ ok: false, error: String(err) });
      }
    }
    return true;
  });
})();
