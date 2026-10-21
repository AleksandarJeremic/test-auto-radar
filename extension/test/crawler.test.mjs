/* Tests for the crawler's scheduling logic against a fake chrome API.
 *
 * Run: node extension/test/crawler.test.mjs
 *
 * The point is the decisions, not the network: does it stay off until enabled,
 * honour the daily cap, open exactly one tab, prefer shallow pages, fold in the
 * next page, schedule a revisit, and refuse paths robots.txt disallows.
 */

let failures = 0;
function check(label, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  const ok = g === w;
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}: ${g}${ok ? '' : `  (ocekivano ${w})`}`);
}
const section = (s) => console.log(`\n${s}`);

// ----------------------------------------------------------- fake chrome

const store = {};
const tabs = { created: [], removed: [], nextId: 100 };

globalThis.chrome = {
  storage: {
    local: {
      async get(key) {
        if (typeof key === 'string') return key in store ? { [key]: store[key] } : {};
        const out = {};
        for (const k of [].concat(key)) if (k in store) out[k] = store[k];
        return out;
      },
      async set(obj) { Object.assign(store, structuredClone(obj)); },
      async remove(keys) { for (const k of [].concat(keys)) delete store[k]; },
    },
  },
  tabs: {
    async create({ url }) {
      const tab = { id: tabs.nextId++, url };
      tabs.created.push(url);
      return tab;
    },
    async remove(id) { tabs.removed.push(id); },
  },
};

const crawler = await import('../src/crawler.js');

const reset = async () => {
  for (const k of Object.keys(store)) delete store[k];
  tabs.created.length = 0;
  tabs.removed.length = 0;
};

const SEARCH = 'https://www.polovniautomobili.com/auto-oglasi/pretraga?brand=volkswagen';

// ------------------------------------------------------------------ tests

section('robots.txt i validacija URL-a');
check('pretraga je dozvoljena', crawler.isAllowed(SEARCH), true);
check('/api/ je zabranjen',
  crawler.isAllowed('https://www.polovniautomobili.com/api/oglasi'), false);
check('/login je zabranjen',
  crawler.isAllowed('https://www.polovniautomobili.com/login'), false);
check('tudji domen odbijen', crawler.isAllowed('https://example.com/auto-oglasi/pretraga'), false);
check('lazni poddomen odbijen',
  crawler.isAllowed('https://polovniautomobili.com.evil.ru/x'), false);
check('http odbijen', crawler.isAllowed('http://www.polovniautomobili.com/auto-oglasi/x'), false);
check('smece odbijeno', crawler.isAllowed('nije-url'), false);

section('Seed lista');
await reset();
let saved = await crawler.setSeeds([SEARCH, '  ', SEARCH, 'https://example.com/x']);
check('duplikati i smece odbaceni', saved.length, 1);
check('u redu je jedna stranica', (await crawler.status()).frontierSize, 1);

await reset();
await crawler.setSeeds([SEARCH + '&utm_source=fb', SEARCH]);
check('utm parametri ne prave duplikat', (await crawler.status()).frontierSize, 1);

section('Ne radi dok se ne ukljuci');
await reset();
await crawler.setSeeds([SEARCH]);
check('tick preskace', (await crawler.tick()).skipped, 'disabled');
check('nijedan tab nije otvoren', tabs.created.length, 0);

section('Otvara tacno jednu stranicu');
await crawler.setConfig({ enabled: true });
let r = await crawler.tick();
check('otvorena pretraga', r.opened, SEARCH);
check('jedan tab', tabs.created.length, 1);
check('drugi tick ne otvara paralelno', (await crawler.tick()).skipped, 'busy');

section('Prijava stranice -> sledeca strana u red');
const openTab = store['radar:crawl:open'].tabId;
const reported = await crawler.onPageReported(openTab, {
  listings: [{ external_id: '1' }, { external_id: '2' }],
  pagination: { page: 1, next_url: SEARCH + '&page=2' },
});
check('prijava prihvacena', reported, true);
check('tab zatvoren', tabs.removed.length, 1);
check('red narastao na 2', (await crawler.status()).frontierSize, 2);
check('prva strana nije vise na redu', (await crawler.status()).dueNow, 1);

section('Tudje tabove ne dira');
check('nepoznat tabId ignorisan', await crawler.onPageReported(9999, { listings: [] }), false);

section('Dubina: plitke strane prvo');
await reset();
await crawler.setSeeds([SEARCH, SEARCH.replace('volkswagen', 'skoda')]);
await crawler.setConfig({ enabled: true, intervalMinutes: 0 });
// deep page queued first, but page 1 of the other search must still win
await crawler.enqueue(SEARCH + '&page=7', { depth: 7, seed: SEARCH });
store['radar:crawl:stats'] = {};
r = await crawler.tick();
check('uzeta plitka strana', r.opened.includes('page=7'), false);

section('Dnevni limit');
await reset();
await crawler.setSeeds([SEARCH]);
await crawler.setConfig({ enabled: true, intervalMinutes: 0, dailyCap: 2 });
for (let i = 0; i < 2; i++) {
  await crawler.tick();
  const t = store['radar:crawl:open'];
  if (t) await crawler.onPageReported(t.tabId, { listings: [], pagination: { next_url: `${SEARCH}&page=${i + 2}` } });
}
check('obidjene 2 strane', tabs.created.length, 2);
check('treci tick staje na limitu', (await crawler.tick()).skipped, 'daily-cap');

section('Dubina pagiranja je ogranicena');
await reset();
await crawler.setSeeds([SEARCH]);
await crawler.setConfig({ enabled: true, intervalMinutes: 0, dailyCap: 999, maxDepth: 3 });
for (let i = 0; i < 6; i++) {
  await crawler.tick();
  const t = store['radar:crawl:open'];
  if (!t) break;
  const page = Number(new URL(t.url).searchParams.get('page') || 1);
  await crawler.onPageReported(t.tabId, {
    listings: [], pagination: { next_url: `${SEARCH}&page=${page + 1}` },
  });
}
check('red stao na maxDepth', (await crawler.status()).frontierSize, 3);

section('Ponovna poseta se zakazuje');
await reset();
await crawler.setSeeds([SEARCH]);
await crawler.setConfig({ enabled: true, intervalMinutes: 0, revisitHours: 24 });
await crawler.tick();
await crawler.onPageReported(store['radar:crawl:open'].tabId, { listings: [], pagination: {} });
const entry = store['radar:crawl:frontier'][0];
const hoursAway = (entry.due - Date.now()) / 3600_000;
check('zakazana za ~24h', hoursAway > 23.9 && hoursAway < 24.1, true);
check('nista nije odmah na redu', (await crawler.status()).dueNow, 0);

section('Zaglavljen tab se odblokira');
await reset();
await crawler.setSeeds([SEARCH]);
await crawler.setConfig({ enabled: true, intervalMinutes: 0, tabTimeoutMs: 1 });
await crawler.tick();
check('zauzeto', (await crawler.status()).busy, true);
await new Promise((res) => setTimeout(res, 5));
await crawler.tick();                       // reaps the stale tab
check('vise nije zauzeto', (await crawler.status()).busy, false);
check('greska zabelezena', (await crawler.status()).lastError?.startsWith('nema odgovora'), true);
check('strana odlozena, ne odmah ponovo', (await crawler.status()).dueNow, 0);

console.log('\n' + (failures ? `IMA ${failures} PADOVA` : 'SVE PROLAZI'));
process.exit(failures ? 1 : 0);
