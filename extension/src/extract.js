/* Auto Radar — extraction layer.
 *
 * Deliberately avoids hand-picked CSS classes: classifieds reshuffle their
 * markup every few months and a selector-based parser dies silently. Instead we
 * walk a ladder of strategies, from most structured to most forgiving:
 *
 *   1. framework state (__NEXT_DATA__ / __NUXT__)  — exact, when present
 *   2. JSON-LD                                      — exact, SEO-driven, stable
 *   3. labelled spec rows ("Godište", "Kilometraža") — survives restyling
 *   4. free-text regex over a card's innerText       — last resort, always works
 *
 * Each record carries `via` so we can see which rung actually fired and tune
 * the ones above it.
 */

const Radar = (() => {
  const SITE = 'polovniautomobili.com';
  const ID_RE = /\/auto-oglasi\/(\d+)(?:[/?#]|$)/;

  const MIN_YEAR = 1950;
  const MAX_YEAR = new Date().getFullYear() + 1;

  // ---------------------------------------------------------------- numbers

  /** sr-RS formatting: "." groups thousands, "," is the decimal separator. */
  function toNumber(raw) {
    if (raw == null) return null;
    const m = String(raw).replace(/[  ]/g, ' ').match(/-?[\d][\d.,\s]*/);
    if (!m) return null;
    const cleaned = m[0].replace(/[\s.]/g, '').replace(',', '.');
    const n = Number(cleaned);
    return Number.isFinite(n) ? n : null;
  }

  /* One number, not several glued together.
   *
   * The first version allowed whitespace inside the digit run, so card text
   * like "Advance 4 42.999 €" parsed as 442999 and "3 47.000 km" as 347000 —
   * both seen on the live site. Thousands groups must be exactly three digits,
   * which makes the stray leading digit fail to attach and lets the match
   * restart on the real number.
   */
  const SEP = '[.\\u00a0\\u202f ]';
  const NUM = `\\d{1,3}(?:${SEP}\\d{3})+|\\d+(?:,\\d+)?`;

  /* The lookbehind is what makes it safe. Without it the engine happily starts
   * mid-number: in "2024 347.000 km" it matched "024 347.000" — reading the
   * gap as a thousands separator — and produced 24.347.000 km. Refusing to
   * begin straight after a digit forces the match onto a real number boundary.
   */
  const PRICE_RE = new RegExp(`(?<!\\d)(${NUM})\\s*(€|eur|rsd|din\\b)`, 'i');
  const MILEAGE_RE = new RegExp(`(?<!\\d)(${NUM})\\s*km\\b`, 'i');

  // Outside these bands a "price" is a misread, not a bargain or a supercar.
  // Reporting null is safe: the collector keeps the last known price rather
  // than reading the gap as a change.
  const PRICE_BOUNDS = { EUR: [200, 400_000], RSD: [20_000, 50_000_000] };

  function parsePrice(text) {
    if (!text) return null;
    const t = String(text).replace(/[  ]/g, ' ');
    if (/po\s*dogovoru|na\s*upit/i.test(t)) return { price: null, currency: null, on_request: true };
    const m = t.match(PRICE_RE);
    if (!m) return null;
    const value = toNumber(m[1]);
    const currency = /€|eur/i.test(m[2]) ? 'EUR' : 'RSD';
    const [lo, hi] = PRICE_BOUNDS[currency];
    if (value == null || value < lo || value > hi) return null;

    return { price: Math.round(value), currency, on_request: false };
  }

  function parseMileage(text) {
    if (!text) return null;
    const m = String(text).match(MILEAGE_RE);
    if (!m) return null;
    const v = toNumber(m[1]);
    return v != null && v >= 0 && v < 2_000_000 ? Math.round(v) : null;
  }

  function parseYear(text) {
    if (!text) return null;
    for (const m of String(text).matchAll(/\b(19\d{2}|20\d{2})\b/g)) {
      const y = Number(m[1]);
      if (y >= MIN_YEAR && y <= MAX_YEAR) return y;
    }
    return null;
  }

  // ------------------------------------------------------------- structured

  function jsonScripts(selector) {
    const out = [];
    for (const el of document.querySelectorAll(selector)) {
      try {
        out.push(JSON.parse(el.textContent));
      } catch { /* malformed blocks are common; skip quietly */ }
    }
    return out;
  }

  /** Depth-first walk over parsed JSON, yielding every object node. */
  function* walk(node, depth = 0) {
    if (!node || typeof node !== 'object' || depth > 12) return;
    if (Array.isArray(node)) {
      for (const v of node) yield* walk(v, depth + 1);
      return;
    }
    yield node;
    for (const v of Object.values(node)) yield* walk(v, depth + 1);
  }

  const VEHICLE_TYPES = new Set(['Car', 'Vehicle', 'Product', 'Offer', 'IndividualProduct']);

  function fromJsonLd() {
    const found = [];
    for (const root of jsonScripts('script[type="application/ld+json"]')) {
      for (const node of walk(root)) {
        const type = [].concat(node['@type'] || []).map(String);
        if (!type.some((t) => VEHICLE_TYPES.has(t))) continue;

        const offer = node.offers && [].concat(node.offers)[0];
        const url = node.url || offer?.url || location.href;
        const idm = String(url).match(ID_RE);

        const rec = {
          external_id: idm ? idm[1] : null,
          url: String(url),
          title: node.name || node.model || null,
          brand: typeof node.brand === 'object' ? node.brand?.name : node.brand,
          model: typeof node.model === 'object' ? node.model?.name : node.model,
          year: parseYear(node.modelDate || node.productionDate || node.vehicleModelDate),
          price: offer?.price != null ? Math.round(toNumber(offer.price)) : null,
          currency: offer?.priceCurrency || null,
          mileage: node.mileageFromOdometer
            ? toNumber(node.mileageFromOdometer.value ?? node.mileageFromOdometer)
            : null,
          fuel: node.fuelType || null,
          transmission: node.vehicleTransmission || null,
          body: node.bodyType || null,
          vin: node.vehicleIdentificationNumber || null,
          via: 'json-ld',
        };
        if (rec.external_id) found.push(rec);
      }
    }
    return found;
  }

  function fromFrameworkState() {
    const roots = jsonScripts('script#__NEXT_DATA__');
    try {
      if (window.wrappedJSObject?.__NUXT__) roots.push(window.wrappedJSObject.__NUXT__);
    } catch { /* isolated world: not reachable, fine */ }

    const found = [];
    for (const root of roots) {
      for (const node of walk(root)) {
        // Heuristic: a listing object carries an id plus a price-ish field.
        const id = node.id ?? node.adId ?? node.classifiedId;
        if (id == null || typeof id === 'object') continue;
        const price = node.price ?? node.priceEur ?? node.cena;
        if (price == null || typeof price === 'object') continue;

        found.push({
          external_id: String(id).match(/\d+/)?.[0] ?? null,
          url: node.url ? new URL(node.url, location.origin).href : null,
          title: node.title || node.name || null,
          brand: node.brand || node.make || null,
          model: node.model || null,
          year: parseYear(node.year ?? node.productionYear ?? node.godiste),
          price: Math.round(toNumber(price) ?? NaN) || null,
          currency: node.currency || null,
          mileage: parseMileage(String(node.mileage ?? node.kilometraza ?? '')) ??
            (toNumber(node.mileage) ?? null),
          fuel: node.fuel || node.fuelType || null,
          transmission: node.transmission || node.gearbox || null,
          via: 'framework-state',
        });
      }
    }
    return found.filter((r) => r.external_id);
  }

  // ---------------------------------------------------------- labelled rows

  const SPEC_LABELS = {
    year: ['Godište', 'Godina proizvodnje'],
    mileage: ['Kilometraža'],
    fuel: ['Gorivo'],
    transmission: ['Menjač'],
    body: ['Karoserija'],
    engine_ccm: ['Kubikaža'],
    engine_kw: ['Snaga motora'],
    doors: ['Broj vrata'],
    drivetrain: ['Pogon'],
    emission: ['Emisiona klasa motora'],
    color: ['Boja'],
    posted_at: ['Datum postavljanja', 'Obnovljen'],
  };

  /** Leaf-ish elements only — nodes whose text is their own, not an aggregate. */
  function leafTexts(root) {
    const out = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    for (let el = walker.nextNode(); el; el = walker.nextNode()) {
      if (el.children.length > 2) continue;
      const t = (el.textContent || '').trim();
      if (!t || t.length > 120) continue;
      out.push([t, el]);
    }
    return out;
  }

  function fromSpecLabels(root = document.body) {
    const leaves = leafTexts(root);
    const spec = {};

    for (const [key, labels] of Object.entries(SPEC_LABELS)) {
      for (const label of labels) {
        const hit = leaves.find(([t]) => t === label || t === label + ':' || t.startsWith(label + ':'));
        if (!hit) continue;
        const [text, el] = hit;

        // The value sits either after the colon, in the next sibling, or in the
        // row's second cell — try all three before giving up on this label.
        let value = text.includes(':') ? text.split(':').slice(1).join(':').trim() : '';
        if (!value) value = (el.nextElementSibling?.textContent || '').trim();
        if (!value) {
          const row = el.closest('tr, li, div');
          const cells = row ? [...row.children].map((c) => (c.textContent || '').trim()) : [];
          value = cells.find((c) => c && c !== label && !c.startsWith(label)) || '';
        }
        if (value) { spec[key] = value; break; }
      }
    }

    return {
      year: parseYear(spec.year),
      mileage: parseMileage(spec.mileage),
      fuel: spec.fuel || null,
      transmission: spec.transmission || null,
      body: spec.body || null,
      engine_ccm: toNumber(spec.engine_ccm),
      engine_kw: toNumber(spec.engine_kw),
      drivetrain: spec.drivetrain || null,
      color: spec.color || null,
      posted_at_raw: spec.posted_at || null,
      via: Object.keys(spec).length ? 'spec-labels' : null,
    };
  }

  // ------------------------------------------------------- slug inference

  /* Search cards carry no brand/model fields, but the ad URL ends in a slug
   * that starts with them: /auto-oglasi/29093553/hyundai-tucson-16-tgdi-...
   * Longest-prefix match against a brand list, because several brands are
   * themselves hyphenated and a naive split would cut "alfa-romeo" in half.
   * Values derived here are a stopgap — the collector lets a detail page
   * overwrite them and never the other way round.
   */
  const BRANDS = [
    'alfa-romeo', 'aston-martin', 'great-wall', 'land-rover', 'range-rover',
    'mercedes-benz', 'rolls-royce', 'ssangyong', 'dr-automobiles',
    'abarth', 'acura', 'audi', 'bentley', 'bmw', 'buick', 'bydcadillac',
    'cadillac', 'chevrolet', 'chrysler', 'citroen', 'cupra', 'dacia', 'daewoo',
    'daihatsu', 'dodge', 'ds', 'ferrari', 'fiat', 'ford', 'honda', 'hummer',
    'hyundai', 'infiniti', 'isuzu', 'iveco', 'jaguar', 'jeep', 'kia',
    'lada', 'lamborghini', 'lancia', 'lexus', 'lincoln', 'lotus', 'maserati',
    'mazda', 'mg', 'mini', 'mitsubishi', 'nissan', 'opel', 'peugeot',
    'polestar', 'pontiac', 'porsche', 'renault', 'rover', 'saab', 'seat',
    'skoda', 'smart', 'subaru', 'suzuki', 'tesla', 'toyota', 'volkswagen',
    'volvo', 'yugo', 'zastava',
  ].sort((a, b) => b.length - a.length);

  const titleCase = (s) => s.replace(/\b[a-zčćđšž]/g, (c) => c.toUpperCase());

  const SLUG_RE = /\/auto-oglasi\/\d+\/([^/?#]+)/;

  function fromSlug(url) {
    const slug = (String(url || '').match(SLUG_RE)?.[1] || '').toLowerCase();
    if (!slug) return {};

    const brand = BRANDS.find((b) => slug === b || slug.startsWith(b + '-'));
    if (!brand) return {};

    const rest = slug.slice(brand.length).split('-').filter(Boolean);
    const model = [];
    for (const token of rest) {
      // Engine displacement ("16", "20") marks the end of the model name;
      // a lone digit does not, or "golf-7" would come out as just "golf".
      if (/^\d{2,}$/.test(token)) break;
      model.push(token);
      if (model.length === 2) break;
    }

    return {
      brand: titleCase(brand.replace(/-/g, ' ')),
      model: modelCase(model),
    };
  }

  /* Initial-style model names keep their hyphen and go uppercase ("cr","v" ->
   * "CR-V"); word-style ones read as words ("c","klasa" -> "C Klasa"). The
   * detail page overrides either way, so this only has to be plausible. */
  function modelCase(tokens) {
    if (!tokens.length) return null;
    const initials = tokens.every((t) => t.length <= 2);
    return initials
      ? tokens.map((t) => t.toUpperCase()).join('-')
      : titleCase(tokens.join(' '));
  }

  // ------------------------------------------------------------ search page

  /* Cards print fuel and gearbox as bare words rather than labelled rows, so
   * match the vocabulary directly. Word boundaries matter: "Benzin" must not
   * fire on "Benzinska pumpa" in a dealer's name. */
  const CARD_WORDS = {
    // Most specific first: "Benzin + gas" would otherwise be caught by "Benzin".
    fuel: [
      [/\bbenzin\s*\+\s*gas\b|\bTNG\b/i, 'Benzin + gas'],
      [/\bmetan\b|\bCNG\b/i, 'Metan CNG'],
      [/\bhibrid/i, 'Hibridni pogon'],
      [/\belektro\b|\belektri[čc]ni\b/i, 'Električni pogon'],
      [/\bdizel\b/i, 'Dizel'],
      [/\bbenzin\b/i, 'Benzin'],
    ],
    transmission: [
      [/\bautomatski\b|\bautomatik\b/i, 'Automatski'],
      [/\bpoluautomatski\b/i, 'Poluautomatski'],
      [/\bmanuelni\b/i, 'Manuelni'],
    ],
  };

  function fromCardWords(text) {
    const out = {};
    for (const [field, rules] of Object.entries(CARD_WORDS)) {
      for (const [re, value] of rules) {
        if (re.test(text)) { out[field] = value; break; }
      }
    }
    return out;
  }

  /** Smallest ancestor of `a` that still describes exactly one listing. */
  function pickCard(a) {
    let el = a;
    let best = a;
    for (let i = 0; i < 8 && el?.parentElement; i++) {
      el = el.parentElement;
      const ids = new Set();
      for (const link of el.querySelectorAll('a[href*="/auto-oglasi/"]')) {
        const m = (link.getAttribute('href') || '').match(ID_RE);
        if (m) ids.add(m[1]);
      }
      if (ids.size > 1) break; // climbed into the list itself — stop at previous
      best = el;
    }
    return best;
  }

  function cardTitle(a, card) {
    const heading = card.querySelector('h1, h2, h3, h4');
    const candidates = [heading?.textContent, a.getAttribute('title'), a.textContent];
    for (const c of candidates) {
      const t = (c || '').trim().replace(/\s+/g, ' ');
      if (t.length >= 4 && t.length <= 160) return t;
    }
    return null;
  }

  function fromSearchPage() {
    const byId = new Map();

    for (const a of document.querySelectorAll('a[href*="/auto-oglasi/"]')) {
      const m = (a.getAttribute('href') || '').match(ID_RE);
      if (!m) continue;

      const card = pickCard(a);
      const text = (card.innerText || '').replace(/\s+/g, ' ').trim();
      const priceInfo = parsePrice(text) || {};

      const url = new URL(a.getAttribute('href'), location.origin).href;
      const rec = {
        external_id: m[1],
        url,
        title: cardTitle(a, card),
        ...fromSlug(url),
        price: priceInfo.price ?? null,
        currency: priceInfo.currency ?? null,
        on_request: priceInfo.on_request ?? false,
        mileage: parseMileage(text),
        year: parseYear(text),
        ...fromCardWords(text),
        via: 'search-card',
      };

      // The same ad is linked several times (image, title, dealer). Keep the
      // variant that actually resolved the most fields.
      const filled = (r) => ['price', 'mileage', 'year', 'title'].filter((k) => r[k] != null).length;
      const prev = byId.get(rec.external_id);
      if (!prev || filled(rec) > filled(prev)) byId.set(rec.external_id, rec);
    }

    // Result pages ship __NEXT_DATA__ too, and it carries exact values for the
    // same ads — fuel and transmission among them, which card text does not
    // reliably show. Where it covers an ad, it wins over the text guesses.
    for (const rec of fromFrameworkState()) {
      const card = byId.get(rec.external_id);
      if (!card) { byId.set(rec.external_id, rec); continue; }
      byId.set(rec.external_id, { ...card, ...prune(rec), via: 'framework-state' });
    }

    return [...byId.values()];
  }

  // ------------------------------------------------------------ detail page

  function detailId() {
    return location.pathname.match(ID_RE)?.[1] ?? null;
  }

  function fromDetailPage() {
    const id = detailId();
    if (!id) return [];

    const structured = [...fromFrameworkState(), ...fromJsonLd()].filter((r) => r.external_id === id);
    const spec = fromSpecLabels();
    const bodyText = (document.body.innerText || '').replace(/\s+/g, ' ');
    const priceInfo = parsePrice(bodyText) || {};

    const base = {
      external_id: id,
      url: location.href.split('#')[0],
      title: (document.querySelector('h1')?.textContent || document.title || '').trim() || null,
      via: 'detail-text',
    };

    // Later sources win only where earlier ones left a hole.
    const merged = Object.assign(
      base,
      { price: priceInfo.price ?? null, currency: priceInfo.currency ?? null, on_request: priceInfo.on_request ?? false },
      prune(spec),
      ...structured.map(prune),
    );
    merged.via = structured[0]?.via || spec.via || 'detail-text';
    return [merged];
  }

  function prune(obj) {
    const out = {};
    for (const [k, v] of Object.entries(obj || {})) {
      if (v !== null && v !== undefined && v !== '' && k !== 'via') out[k] = v;
    }
    return out;
  }

  // ------------------------------------------------------------------ entry

  function pageType() {
    if (detailId()) return 'detail';
    if (/\/auto-oglasi\//.test(location.pathname)) return 'search';
    return 'other';
  }

  /** Where this page sits in the result set, and whether another one follows.
   *
   *  "Next" is asserted only when the page itself links to page N+1 — guessing
   *  from the URL alone would walk forever past the last result.
   */
  function paginationInfo() {
    const current = Number(new URLSearchParams(location.search).get('page') || 1);
    const pages = new Set();
    for (const a of document.querySelectorAll('a[href*="page="]')) {
      const m = (a.getAttribute('href') || '').match(/[?&]page=(\d+)/);
      if (m) pages.add(Number(m[1]));
    }

    const hasNext = pages.has(current + 1) || !!document.querySelector('a[rel="next"]');
    let nextUrl = null;
    if (hasNext) {
      const u = new URL(location.href);
      u.searchParams.set('page', String(current + 1));
      u.hash = '';
      nextUrl = u.href;
    }

    return {
      page: current,
      next_url: nextUrl,
      last_page_linked: pages.size ? Math.max(...pages) : current,
    };
  }

  function scan() {
    const type = pageType();
    let listings = [];
    if (type === 'detail') listings = fromDetailPage();
    else if (type === 'search') listings = fromSearchPage();

    return {
      site: SITE,
      page_type: type,
      url: location.href.split('#')[0],
      scanned_at: new Date().toISOString(),
      pagination: type === 'search' ? paginationInfo() : null,
      listings: listings.filter((r) => r.external_id),
    };
  }

  /** Human-readable snapshot for tuning the parser against a live page. */
  function debugReport() {
    const payload = scan();
    const anchors = document.querySelectorAll('a[href*="/auto-oglasi/"]').length;
    return {
      url: payload.url,
      page_type: payload.page_type,
      counts: {
        listing_anchors: anchors,
        extracted: payload.listings.length,
        json_ld_blocks: document.querySelectorAll('script[type="application/ld+json"]').length,
        next_data: document.querySelectorAll('script#__NEXT_DATA__').length,
      },
      via_breakdown: payload.listings.reduce((acc, r) => {
        acc[r.via] = (acc[r.via] || 0) + 1;
        return acc;
      }, {}),
      field_coverage: ['price', 'mileage', 'year', 'title', 'fuel', 'transmission'].reduce((acc, k) => {
        acc[k] = payload.listings.filter((r) => r[k] != null && r[k] !== '').length;
        return acc;
      }, {}),
      // A missing price is not automatically a parser miss: "Po dogovoru" ads
      // have none to find. Counted separately so the two cannot be confused.
      on_request: payload.listings.filter((r) => r.on_request).length,
      no_price_no_reason: payload.listings.filter((r) => r.price == null && !r.on_request).length,
      // The records that resolved worst — the ones worth looking at. Showing
      // the first few instead would mostly show the ones already working.
      weakest: [...payload.listings]
        .sort((a, b) => resolved(a) - resolved(b))
        .slice(0, 3),
      sample: payload.listings.filter((r) => resolved(r) >= 4).slice(0, 1),
    };
  }

  const DEBUG_FIELDS = ['price', 'mileage', 'year', 'title', 'fuel', 'transmission', 'brand', 'model'];
  const resolved = (r) => DEBUG_FIELDS.filter((k) => r[k] != null && r[k] !== '').length;

  return { scan, debugReport, toNumber, parsePrice, parseMileage, parseYear, fromSlug, fromCardWords, SITE };
})();
