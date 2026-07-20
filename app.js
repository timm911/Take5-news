/* Take5-AI News — live headlines on a 5-minute cycle. */
(() => {
  'use strict';

  // ---------- Config ----------

  const GN = 'https://news.google.com/rss';
  const LOCALE = 'hl=en-US&gl=US&ceid=US:en';
  // gn: true → Google News feed; the publisher name is embedded in each
  // item's title and gets extracted. Other feeds carry their outlet name.
  const gn = (t) => ({ url: `${GN}/headlines/section/topic/${t}?${LOCALE}`, gn: true });
  const src = (url, name) => ({ url, name });

  const SECTIONS = [
    { id: 'top', title: 'Top Stories', feeds: [
      { url: `${GN}?${LOCALE}`, gn: true },
      src('https://feeds.bbci.co.uk/news/rss.xml', 'BBC'),
      src('https://feeds.npr.org/1001/rss.xml', 'NPR'),
    ] },
    { id: 'world', title: 'World', feeds: [
      gn('WORLD'),
      src('https://feeds.bbci.co.uk/news/world/rss.xml', 'BBC'),
      src('https://www.theguardian.com/world/rss', 'The Guardian'),
    ] },
    { id: 'us', title: 'U.S.', feeds: [
      gn('NATION'),
      src('https://feeds.npr.org/1003/rss.xml', 'NPR'),
      src('https://www.theguardian.com/us-news/rss', 'The Guardian'),
      src('https://rss.nytimes.com/services/xml/rss/nyt/US.xml', 'NYT'),
    ] },
    { id: 'business', title: 'Business', feeds: [
      gn('BUSINESS'),
      src('https://www.cnbc.com/id/10001147/device/rss/rss.html', 'CNBC'),
      src('https://feeds.content.dowjones.io/public/rss/mw_topstories', 'MarketWatch'),
      src('https://rss.nytimes.com/services/xml/rss/nyt/Business.xml', 'NYT'),
    ] },
    { id: 'tech', title: 'Technology', feeds: [
      gn('TECHNOLOGY'),
      src('https://www.theverge.com/rss/index.xml', 'The Verge'),
      src('https://feeds.arstechnica.com/arstechnica/index', 'Ars Technica'),
      src('https://techcrunch.com/feed/', 'TechCrunch'),
    ] },
    { id: 'ai', title: 'AI', feeds: [
      { url: `${GN}/search?q=${encodeURIComponent('"artificial intelligence" OR OpenAI OR Anthropic OR "machine learning"')}&${LOCALE}`, gn: true },
      src('https://www.theverge.com/rss/ai-artificial-intelligence/index.xml', 'The Verge'),
      src('https://www.technologyreview.com/topic/artificial-intelligence/feed', 'MIT Tech Review'),
      src('https://venturebeat.com/category/ai/feed/', 'VentureBeat'),
      src('https://openai.com/blog/rss.xml', 'OpenAI'),
    ] },
    { id: 'hn', title: 'Hacker News', hn: true, feeds: [] },
    { id: 'science', title: 'Science', feeds: [
      gn('SCIENCE'),
      src('https://www.sciencedaily.com/rss/all.xml', 'ScienceDaily'),
      src('https://www.nasa.gov/rss/dyn/breaking_news.rss', 'NASA'),
      src('https://www.nature.com/nature.rss', 'Nature'),
    ] },
    { id: 'health', title: 'Health', feeds: [
      gn('HEALTH'),
      src('https://www.statnews.com/feed/', 'STAT'),
      src('https://rss.nytimes.com/services/xml/rss/nyt/Health.xml', 'NYT'),
    ] },
    { id: 'sports', title: 'Sports', feeds: [
      gn('SPORTS'),
      src('https://feeds.bbci.co.uk/sport/rss.xml', 'BBC Sport'),
      src('https://www.skysports.com/rss/12040', 'Sky Sports'),
    ] },
    { id: 'entertainment', title: 'Entertainment', feeds: [
      gn('ENTERTAINMENT'),
      src('https://variety.com/feed/', 'Variety'),
      src('https://www.hollywoodreporter.com/feed/', 'The Hollywood Reporter'),
    ] },
  ];

  const STORIES_PER_SECTION = 5;
  const POOL_MAX = 25; // stories kept per section so each cycle can rotate in a fresh five
  const HN_STORIES = 20;
  const FETCH_TIMEOUT_MS = 8000;
  const CACHE_KEY = 'take5.cache.v2';
  const STALE_AFTER_MS = 30 * 60 * 1000;

  // T5 analysis backend (Cloudflare Worker). When set, clicking a headline
  // opens the T5 card; the source name under each headline links straight to
  // the article. When empty, headlines link directly as before.
  // Overridable for testing via ?t5api=<url>.
  const T5_API_DEFAULT = '';
  const T5_API = new URLSearchParams(location.search).get('t5api') || T5_API_DEFAULT;
  const CARD_CACHE_KEY = 'take5.cards.v1';
  const CARD_CACHE_MAX = 40;

  const debugSecs = Number(new URLSearchParams(location.search).get('debug'));
  const CYCLE_MS = debugSecs >= 5 ? debugSecs * 1000 : 5 * 60 * 1000;
  // The relays rate-limit bursts (~18 rapid requests trips HTTP 429), so the
  // ~35 feed fetches are spread across the cycle instead: the harvest starts
  // right after each swap and must wrap up this long before the next zero.
  const HARVEST_MARGIN_MS = Math.min(30000, Math.floor(CYCLE_MS / 3));
  const INITIAL_WINDOW_MS = Math.min(90000, Math.floor(CYCLE_MS / 2));

  // ---------- State ----------

  const data = {}; // sectionId -> { fetchedAt, items: pool of up to POOL_MAX {title, link, source, pubDate} }
  const shown = {}; // sectionId -> Set of links displayed last cycle, so rotation avoids repeats
  let deadline = 0;
  let prefetchPromise = null;
  let lastShownSecond = -1;

  // ---------- DOM helpers / rendering ----------

  const $ = (id) => document.getElementById(id);
  const grid = $('grid');
  const statusEl = $('status');
  const timerEl = $('timer');

  function buildCards() {
    for (const s of SECTIONS) {
      const card = document.createElement('section');
      card.className = 'card';
      card.id = `card-${s.id}`;
      const h2 = document.createElement('h2');
      h2.textContent = s.title;
      const ol = document.createElement('ol');
      for (let i = 0; i < STORIES_PER_SECTION; i++) {
        const li = document.createElement('li');
        const bar = document.createElement('div');
        bar.className = 'skel';
        bar.style.width = `${70 + ((i * 7) % 25)}%`;
        li.appendChild(bar);
        ol.appendChild(li);
      }
      card.append(h2, ol);
      grid.appendChild(card);
    }
  }

  function relTime(pubDate) {
    const t = Date.parse(pubDate);
    if (!t) return '';
    const mins = Math.round((Date.now() - t) / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.round(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    return `${Math.round(hrs / 24)}d ago`;
  }

  // Pick the five stories to display. With rotate, stories not shown last
  // cycle come first (new stories from Google naturally qualify), so the
  // links visibly change at every swap even when the feed itself hasn't.
  function pickFive(id, rotate) {
    const pool = data[id]?.items || [];
    const last = shown[id] || new Set();
    const ordered = rotate
      ? [...pool.filter((i) => !last.has(i.link)), ...pool.filter((i) => last.has(i.link))]
      : pool;
    const five = ordered.slice(0, STORIES_PER_SECTION);
    shown[id] = new Set(five.map((i) => i.link));
    return five;
  }

  function renderSection(id, rotate) {
    if (!data[id] || !data[id].items.length) return;
    const five = pickFive(id, rotate);
    const ol = $(`card-${id}`).querySelector('ol');
    ol.textContent = '';
    const sectionTitle = SECTIONS.find((s) => s.id === id)?.title || id;
    for (const item of five) {
      const li = document.createElement('li');
      const wrap = document.createElement('div');
      const a = document.createElement('a');
      a.textContent = item.title;
      a.href = item.link;
      if (T5_API) {
        // Headline opens the T5 analysis card; plain modified-clicks (new tab)
        // still follow the href to the article.
        a.className = 't5-link';
        a.addEventListener('click', (e) => {
          if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
          e.preventDefault();
          openCard(item, sectionTitle);
        });
      } else {
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
      }
      wrap.appendChild(a);
      const meta = document.createElement('span');
      meta.className = 'meta';
      if (T5_API && item.source) {
        // Source name becomes the direct link to the article.
        const srcA = document.createElement('a');
        srcA.textContent = item.source;
        srcA.href = item.link;
        srcA.target = '_blank';
        srcA.rel = 'noopener noreferrer';
        meta.appendChild(srcA);
        const t = relTime(item.pubDate);
        if (t) meta.appendChild(document.createTextNode(` · ${t}`));
      } else {
        meta.textContent = [item.source, relTime(item.pubDate)].filter(Boolean).join(' · ');
      }
      if (meta.textContent) wrap.appendChild(meta);
      li.appendChild(wrap);
      ol.appendChild(li);
    }
  }

  function renderAll(rotate) {
    for (const s of SECTIONS) renderSection(s.id, rotate);
  }

  function setStatus(text, stale = false) {
    statusEl.textContent = text;
    statusEl.classList.toggle('stale', stale);
  }

  // ---------- Fetch pipeline ----------

  function isHttpUrl(u) {
    try { return ['http:', 'https:'].includes(new URL(u).protocol); }
    catch { return false; }
  }

  // Merge raw items from all of a section's feeds: newest first, dedupe by
  // title, cap the pool. sortByDate is off for Hacker News (rank order).
  function normalizeItems(raw, sortByDate) {
    if (sortByDate) {
      raw = [...raw].sort((a, b) => (Date.parse(b.pubDate) || 0) - (Date.parse(a.pubDate) || 0));
    }
    const seen = new Set();
    const items = [];
    for (const r of raw) {
      let title = (r.title || '').trim();
      if (!title || !isHttpUrl(r.link)) continue;
      let source = r.source || '';
      if (r.gn) {
        // Google News appends " - Publisher" to titles.
        const dash = title.lastIndexOf(' - ');
        if (dash > 10) {
          source = source || title.slice(dash + 3).trim();
          title = title.slice(0, dash).trim();
        }
      }
      const key = title.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      items.push({ title, link: r.link, source, pubDate: r.pubDate || '' });
      if (items.length === POOL_MAX) break;
    }
    return items;
  }

  async function fetchWithTimeout(url) {
    const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res;
  }

  async function viaRss2json(feed) {
    const res = await fetchWithTimeout(`https://api.rss2json.com/v1/api.json?rss_url=${encodeURIComponent(feed)}`);
    const json = await res.json();
    if (json.status !== 'ok' || !Array.isArray(json.items)) throw new Error('rss2json not ok');
    return json.items.map((i) => ({
      title: i.title,
      link: i.link,
      source: typeof i.source === 'string' ? i.source : (i.source && i.source.title) || '',
      pubDate: i.pubDate,
    }));
  }

  async function viaAllOrigins(feed) {
    const res = await fetchWithTimeout(`https://api.allorigins.win/raw?url=${encodeURIComponent(feed)}`);
    const xml = new DOMParser().parseFromString(await res.text(), 'text/xml');
    if (xml.querySelector('parsererror')) throw new Error('bad xml');
    return [...xml.querySelectorAll('item')].map((item) => {
      const get = (tag) => item.querySelector(tag)?.textContent || '';
      return { title: get('title'), link: get('link'), source: get('source'), pubDate: get('pubDate') };
    });
  }

  async function fetchFeed(feedCfg, cycleToken, relayIndex) {
    // Cache-bust the feed URL so the relays can't serve a stale cached copy —
    // the token changes each cycle, forcing a fresh pull from the publisher.
    // Publishers ignore the extra query parameter.
    const feed = `${feedCfg.url}${feedCfg.url.includes('?') ? '&' : '?'}t5=${cycleToken}`;
    // Alternate which relay is primary per task so the load splits between
    // them; on failure try the other, then the primary once more (a relay's
    // first sight of a never-seen URL occasionally errors while it fetches).
    const relays = relayIndex % 2 ? [viaAllOrigins, viaRss2json] : [viaRss2json, viaAllOrigins];
    let raw;
    try {
      raw = await relays[0](feed);
    } catch {
      try {
        raw = await relays[1](feed);
      } catch {
        raw = await relays[0](feed); // let this one throw
      }
    }
    return raw.map((r) => ({ ...r, source: feedCfg.gn ? r.source : (r.source || feedCfg.name), gn: feedCfg.gn }));
  }

  // Hacker News has a CORS-open official API — no relay needed.
  async function fetchHackerNews() {
    const res = await fetchWithTimeout('https://hacker-news.firebaseio.com/v0/topstories.json');
    const ids = (await res.json()).slice(0, HN_STORIES);
    const items = await Promise.all(ids.map(async (id) => {
      try {
        const r = await fetchWithTimeout(`https://hacker-news.firebaseio.com/v0/item/${id}.json`);
        const it = await r.json();
        if (!it || !it.title) return null;
        return {
          title: it.title,
          link: it.url || `https://news.ycombinator.com/item?id=${id}`,
          source: it.score ? `${it.score} points` : 'Hacker News',
          pubDate: it.time ? new Date(it.time * 1000).toISOString() : '',
        };
      } catch { return null; }
    }));
    return items.filter(Boolean);
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let harvestCount = 0;

  // Fetch every feed once, with launches spread evenly across windowMs so the
  // relays never see a burst. Results accumulate per section and merge into
  // `data` when all tasks settle (the display only changes at the next swap).
  async function harvestAll(windowMs, progressive) {
    const cycleToken = Date.now();
    // One task per feed (not per section) so a slow feed can't hold a whole
    // section hostage.
    const tasks = [];
    for (const s of SECTIONS) {
      if (s.hn) { tasks.push({ id: s.id, run: () => fetchHackerNews() }); continue; }
      for (const f of s.feeds) tasks.push({ id: s.id, run: (i) => fetchFeed(f, cycleToken, i) });
    }
    // Rotate launch order each harvest so no section is systematically last
    // (last in a tight window is first to hit any rate limit).
    const rot = (harvestCount++ * 7) % tasks.length;
    const ordered = tasks.slice(rot).concat(tasks.slice(0, rot));
    const spacing = Math.max(0, windowMs - FETCH_TIMEOUT_MS) / Math.max(1, ordered.length - 1);

    const rawBySection = {};
    await Promise.all(ordered.map((t, i) => (async () => {
      await sleep(i * spacing);
      try {
        const items = await t.run(i);
        if (items.length) (rawBySection[t.id] ||= []).push(...items);
        // On first load, fill each empty card as soon as any of its feeds
        // lands instead of waiting for the whole harvest.
        if (progressive && items.length && !data[t.id]?.items?.length) {
          data[t.id] = { fetchedAt: Date.now(), items: normalizeItems(rawBySection[t.id], t.id !== 'hn') };
          renderSection(t.id, false);
        }
      } catch { /* this feed failed — the section's other feeds still count */ }
    })()));

    let updated = 0;
    for (const s of SECTIONS) {
      const raw = rawBySection[s.id];
      if (!raw) continue; // every feed for this section failed — keep previous stories
      const items = normalizeItems(raw, !s.hn);
      if (items.length) { data[s.id] = { fetchedAt: Date.now(), items }; updated++; }
    }
    if (updated) saveCache();
    return updated;
  }

  // ---------- Cache ----------

  function saveCache() {
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify({ savedAt: Date.now(), sections: data }));
    } catch { /* private mode / quota — ignore */ }
  }

  function loadCache() {
    try {
      const parsed = JSON.parse(localStorage.getItem(CACHE_KEY));
      if (!parsed || !parsed.sections) return null;
      Object.assign(data, parsed.sections);
      return parsed.savedAt || 0;
    } catch { return null; }
  }

  // ---------- T5 analysis card ----------

  function loadCardCache() {
    try { return JSON.parse(localStorage.getItem(CARD_CACHE_KEY)) || {}; }
    catch { return {}; }
  }

  function saveCardCache(cache) {
    try {
      const keys = Object.keys(cache);
      if (keys.length > CARD_CACHE_MAX) {
        keys.sort((a, b) => cache[a].at - cache[b].at)
          .slice(0, keys.length - CARD_CACHE_MAX)
          .forEach((k) => delete cache[k]);
      }
      localStorage.setItem(CARD_CACHE_KEY, JSON.stringify(cache));
    } catch { /* ignore */ }
  }

  let overlayEl = null;

  function closeCard() {
    if (overlayEl) { overlayEl.remove(); overlayEl = null; }
    document.body.style.overflow = '';
  }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text) node.textContent = text;
    return node;
  }

  function cardBlock(panel, label, textOrList) {
    if (!textOrList || (Array.isArray(textOrList) && !textOrList.length)) return;
    const block = el('div', 't5-block');
    block.appendChild(el('h3', 't5-label', label));
    if (Array.isArray(textOrList)) {
      const ul = el('ul', 't5-list');
      for (const item of textOrList) ul.appendChild(el('li', '', item));
      block.appendChild(ul);
    } else {
      block.appendChild(el('p', '', textOrList));
    }
    panel.appendChild(block);
  }

  function renderLeanMeter(panel, lean) {
    if (!lean || lean === 'n/a') return;
    const block = el('div', 't5-block');
    block.appendChild(el('h3', 't5-label', 'Lean'));
    const meter = el('div', 't5-lean');
    const stops = ['left', 'center-left', 'center', 'center-right', 'right'];
    for (const stop of stops) {
      const seg = el('span', 't5-lean-stop' + (stop === lean ? ' active' : ''));
      seg.title = stop;
      meter.appendChild(seg);
    }
    block.appendChild(meter);
    block.appendChild(el('p', 't5-lean-label', lean.toUpperCase()));
    panel.appendChild(block);
  }

  function renderCardContent(panel, item, card) {
    panel.textContent = '';
    const head = el('div', 't5-head');
    head.appendChild(el('span', 't5-brand', 'T5 ANALYSIS'));
    const closeBtn = el('button', 't5-close', '✕');
    closeBtn.addEventListener('click', closeCard);
    head.appendChild(closeBtn);
    panel.appendChild(head);
    panel.appendChild(el('h2', 't5-headline', item.title));

    if (card.error) {
      panel.appendChild(el('p', 't5-error', `Analysis unavailable: ${card.error}`));
    } else {
      if (card.headline_only) panel.appendChild(el('p', 't5-note', 'Article body unreachable — analysis based on the headline.'));
      renderLeanMeter(panel, card.lean);
      cardBlock(panel, 'Bias flags', card.bias_flags);
      cardBlock(panel, 'Missing', card.missing_facts);
      cardBlock(panel, 'Summary', card.summary);
      cardBlock(panel, 'So what?', card.so_what);
      cardBlock(panel, 'Their side', card.their_side);
      cardBlock(panel, 'Other side', card.other_side);
      cardBlock(panel, 'Consistency check', card.consistency_check);
      if (card.for_you_home || card.for_you_work) {
        const bits = [];
        if (card.for_you_home) bits.push(`At home: ${card.for_you_home}`);
        if (card.for_you_work) bits.push(`At work: ${card.for_you_work}`);
        cardBlock(panel, 'What this means for you', bits);
      }
      if (card.terror_summary) {
        const block = el('div', 't5-block t5-terror');
        block.appendChild(el('h3', 't5-label', '⚡ Terror Summary'));
        block.appendChild(el('p', '', card.terror_summary));
        panel.appendChild(block);
      }
    }

    const srcA = el('a', 't5-source', 'READ THE SOURCE →');
    srcA.href = card.source_url && /^https?:/.test(card.source_url) ? card.source_url : item.link;
    srcA.target = '_blank';
    srcA.rel = 'noopener noreferrer';
    panel.appendChild(srcA);
  }

  async function openCard(item, sectionTitle) {
    closeCard();
    overlayEl = el('div', 't5-overlay');
    overlayEl.addEventListener('click', (e) => { if (e.target === overlayEl) closeCard(); });
    const panel = el('div', 't5-panel');
    overlayEl.appendChild(panel);
    document.body.appendChild(overlayEl);
    document.body.style.overflow = 'hidden';

    // Loading state
    panel.appendChild(el('div', 't5-head')).appendChild(el('span', 't5-brand', 'T5 ANALYSIS'));
    panel.appendChild(el('h2', 't5-headline', item.title));
    panel.appendChild(el('p', 't5-analyzing', 'ANALYZING…'));
    for (let i = 0; i < 5; i++) {
      const bar = el('div', 'skel');
      bar.style.width = `${85 - i * 9}%`;
      panel.appendChild(bar);
    }

    const cache = loadCardCache();
    if (cache[item.link]) {
      renderCardContent(panel, item, cache[item.link].card);
      return;
    }

    try {
      const qs = new URLSearchParams({
        url: item.link, title: item.title,
        source: item.source || '', section: sectionTitle,
      });
      const res = await fetch(`${T5_API}?${qs}`, { signal: AbortSignal.timeout(60000) });
      const card = await res.json();
      if (!res.ok) throw new Error(card.error || `HTTP ${res.status}`);
      if (overlayEl) renderCardContent(panel, item, card);
      if (!card.error) {
        cache[item.link] = { card, at: Date.now() };
        saveCardCache(cache);
      }
    } catch (e) {
      if (overlayEl) renderCardContent(panel, item, { error: String(e.message || e) });
    }
  }

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeCard();
  });

  // ---------- Timer engine ----------

  const fmt = (n) => String(n).padStart(2, '0');

  function renderClock(remainingMs) {
    const totalSec = Math.ceil(remainingMs / 1000);
    if (totalSec === lastShownSecond) return;
    lastShownSecond = totalSec;
    const mm = fmt(Math.floor(totalSec / 60));
    const ss = fmt(totalSec % 60);
    $('m1').textContent = mm[mm.length - 2] || '0';
    $('m2').textContent = mm[mm.length - 1];
    $('s1').textContent = ss[0];
    $('s2').textContent = ss[1];
  }

  function startHarvest(windowMs) {
    if (!prefetchPromise) prefetchPromise = harvestAll(Math.max(0, windowMs)).catch(() => 0);
  }

  function markUpdating(on) {
    for (const card of grid.children) card.classList.toggle('updating', on);
  }

  async function onZero() {
    timerEl.classList.remove('flash');
    void timerEl.offsetWidth; // restart the animation
    timerEl.classList.add('flash');
    deadline += CYCLE_MS;
    const p = prefetchPromise;
    prefetchPromise = null;
    // Kick off next cycle's slow harvest immediately so it has the whole
    // window to trickle through the feeds.
    startHarvest(deadline - Date.now() - HARVEST_MARGIN_MS);
    markUpdating(true);
    const updated = p ? await p : 0;
    renderAll(true); // rotate: always surface the five not shown last cycle
    markUpdating(false);
    setStatus(updated
      ? `last updated ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
      : 'refresh failed — showing last known stories', !updated);
  }

  function tick() {
    const remaining = Math.max(0, deadline - Date.now());
    renderClock(remaining);
    // Rescue path: if no harvest is in flight this cycle (e.g. the tab was
    // asleep when the cycle started), run a compressed one now.
    if (!prefetchPromise && remaining > 0) startHarvest(Math.max(0, remaining - HARVEST_MARGIN_MS));
    if (remaining === 0) {
      // Catch up if the tab slept through one or more cycles.
      while (deadline <= Date.now() - CYCLE_MS) deadline += CYCLE_MS;
      onZero();
    }
  }

  function rafLoop() {
    tick();
    requestAnimationFrame(rafLoop);
  }

  // ---------- Boot ----------

  buildCards();

  const cachedAt = loadCache();
  if (cachedAt) {
    renderAll();
    const stale = Date.now() - cachedAt > STALE_AFTER_MS;
    setStatus(stale ? `showing stories from ${relTime(new Date(cachedAt).toISOString())} — refreshing…` : 'refreshing…', stale);
  } else {
    setStatus('acquiring live feeds…');
  }

  deadline = Date.now() + CYCLE_MS;

  // The initial harvest fills the page (progressively, top sections first)
  // and doubles as cycle one's prefetch — onZero consumes it at the first
  // swap. Must be armed before the first tick, or the rescue path in tick()
  // would spawn a duplicate harvest.
  prefetchPromise = harvestAll(INITIAL_WINDOW_MS, true).catch(() => 0);
  prefetchPromise.then((updated) => {
    renderAll();
    setStatus(updated
      ? `last updated ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
      : 'live feeds unreachable — showing cached stories', !updated);
  });

  rafLoop();
  setInterval(tick, 1000); // safety net for throttled/background tabs

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) tick();
  });
})();
