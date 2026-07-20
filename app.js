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
  const POOL_SIZE = 4;
  const STAGGER_MS = 150;
  const CACHE_KEY = 'take5.cache.v2';
  const STALE_AFTER_MS = 30 * 60 * 1000;

  const debugSecs = Number(new URLSearchParams(location.search).get('debug'));
  const CYCLE_MS = debugSecs >= 5 ? debugSecs * 1000 : 5 * 60 * 1000;
  const PREFETCH_MS = Math.min(45000, Math.floor(CYCLE_MS / 2));

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
    for (const item of five) {
      const li = document.createElement('li');
      const wrap = document.createElement('div');
      const a = document.createElement('a');
      a.textContent = item.title;
      a.href = item.link;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      wrap.appendChild(a);
      const metaText = [item.source, relTime(item.pubDate)].filter(Boolean).join(' · ');
      if (metaText) {
        const meta = document.createElement('span');
        meta.className = 'meta';
        meta.textContent = metaText;
        wrap.appendChild(meta);
      }
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

  async function fetchFeed(feedCfg, cycleToken) {
    // Cache-bust the feed URL so the relays can't serve a stale cached copy —
    // the token changes each cycle, forcing a fresh pull from the publisher.
    // Publishers ignore the extra query parameter.
    const feed = `${feedCfg.url}${feedCfg.url.includes('?') ? '&' : '?'}t5=${cycleToken}`;
    let raw;
    try {
      raw = await viaRss2json(feed);
    } catch {
      try {
        // A never-seen URL occasionally errors on the relay's first attempt
        // while it fetches the feed; the immediate retry hits its fresh cache.
        raw = await viaRss2json(feed);
      } catch {
        raw = await viaAllOrigins(feed); // let this one throw
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

  // Small concurrency pool with staggered launches (polite to relay rate limits).
  async function pool(tasks, size) {
    const results = [];
    let next = 0;
    const workers = Array.from({ length: Math.min(size, tasks.length) }, async (_, w) => {
      await new Promise((r) => setTimeout(r, w * STAGGER_MS));
      while (next < tasks.length) {
        const i = next++;
        try { results[i] = { ok: true, value: await tasks[i]() }; }
        catch (e) { results[i] = { ok: false, error: e }; }
      }
    });
    await Promise.all(workers);
    return results;
  }

  async function fetchAllSections() {
    const cycleToken = Date.now();
    // One task per feed (not per section) so slow feeds don't hold a whole
    // section hostage and the concurrency pool stays evenly loaded.
    const tasks = [];
    const owners = [];
    for (const s of SECTIONS) {
      if (s.hn) { tasks.push(() => fetchHackerNews()); owners.push(s.id); continue; }
      for (const f of s.feeds) { tasks.push(() => fetchFeed(f, cycleToken)); owners.push(s.id); }
    }
    const results = await pool(tasks, POOL_SIZE);

    const rawBySection = {};
    results.forEach((r, i) => {
      if (r.ok && r.value.length) (rawBySection[owners[i]] ||= []).push(...r.value);
    });

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

  function startPrefetch() {
    if (!prefetchPromise) prefetchPromise = fetchAllSections().catch(() => 0);
  }

  function markUpdating(on) {
    for (const card of grid.children) card.classList.toggle('updating', on);
  }

  async function onZero() {
    timerEl.classList.remove('flash');
    void timerEl.offsetWidth; // restart the animation
    timerEl.classList.add('flash');
    deadline += CYCLE_MS;
    startPrefetch(); // in case the prefetch window was missed (e.g. throttled tab)
    const p = prefetchPromise;
    prefetchPromise = null;
    markUpdating(true);
    const updated = await p;
    renderAll(true); // rotate: always surface the five not shown last cycle
    markUpdating(false);
    setStatus(updated
      ? `last updated ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
      : 'refresh failed — showing last known stories', !updated);
  }

  function tick() {
    const remaining = Math.max(0, deadline - Date.now());
    renderClock(remaining);
    if (remaining <= PREFETCH_MS && remaining > 0) startPrefetch();
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
  rafLoop();
  setInterval(tick, 1000); // safety net for throttled/background tabs

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) tick();
  });

  fetchAllSections().then((updated) => {
    renderAll();
    setStatus(updated
      ? `last updated ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
      : 'live feeds unreachable — showing cached stories', !updated);
  });
})();
