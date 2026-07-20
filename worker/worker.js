/**
 * Take5-AI News — T5 Analysis Worker (Cloudflare Worker)
 *
 * Receives an article URL, fetches and extracts the article text, asks Claude
 * for the T5 card (summary, lean, bias flags, missing facts, so-what, the
 * conditional blocks, and the Terror Summary), and returns it as JSON.
 *
 * Setup:
 *   1. Paste this file into a new Cloudflare Worker (dash.cloudflare.com).
 *   2. Add a secret named ANTHROPIC_API_KEY (Settings → Variables and Secrets).
 *   3. Deploy; the workers.dev URL is the T5_API endpoint for the site.
 */

const ALLOWED_ORIGINS = [
  'https://timm911.github.io',
  'http://localhost:8000',
  'http://127.0.0.1:8000',
];

const MODEL = 'claude-opus-4-8';
const MAX_ARTICLE_CHARS = 14000;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

// Per-isolate in-memory cache (workers.dev has no persistent Cache API zone;
// this still absorbs repeat clicks, and the browser caches cards client-side).
const memoryCache = new Map();

const VOICE_PROFILE = `You write the "Terror Summary" — a one-to-two sentence verdict in the site
owner's voice. The voice: deadpan logic machine, zero emotion, dry wit.
- Short declarative sentences. If three words cover it, three words.
- Answers spin with a sharper question ("Winning what?").
- Facts and receipts or it's noise. Claims without evidence get mocked, dryly.
- Manufactured news gets named as such: strip the event to what literally
  happened and let the absurdity speak ("It is a sport. He lost. He is sad
  about losing. This has been the news.").
- Unimpressed by fame: actors pretend to be people, singers make noises with
  their throats. A politician's record (votes missed, contradictions) is the
  argument, not their words.
- Respect is given in small denominations ("Good for him.") and lands
  because it is rare.
- The one topic that earns genuine leaning-in: AI as a fire-level invention —
  fascinated by what ordinary people can actually do with it.`;

const CARD_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'summary', 'lean', 'bias_flags', 'missing_facts', 'so_what',
    'their_side', 'other_side', 'consistency_check',
    'for_you_home', 'for_you_work', 'terror_summary',
  ],
  properties: {
    summary: { type: 'string', description: 'Four to five sentences summarizing the entire article.' },
    lean: { type: 'string', enum: ['left', 'center-left', 'center', 'center-right', 'right', 'n/a'], description: 'Political lean of the ARTICLE as written. n/a for non-political stories.' },
    bias_flags: { type: 'array', items: { type: 'string' }, description: 'Specific biased techniques in the article (loaded language, one-sided sourcing, buried facts). Empty if the piece is straight.' },
    missing_facts: { type: 'array', items: { type: 'string' }, description: 'Important facts or perspectives the article omits. Empty if none.' },
    so_what: { type: 'string', description: 'One sentence: why this story matters or the point it is driving at.' },
    their_side: { type: 'string', description: 'POLITICAL STORIES ONLY: one logical, emotion-free sentence for why the party/side behind this considers it good. Empty string otherwise.' },
    other_side: { type: 'string', description: 'POLITICAL STORIES ONLY: one logical, emotion-free sentence for why the opposing side considers it mistaken. Empty string otherwise.' },
    consistency_check: { type: 'string', description: 'CELEBRITY/PUBLIC-FIGURE STORIES: any hypocrisy or illogic between what the figure says and what they do (private jets vs climate speeches; voting record vs rhetoric). Empty string if none applies.' },
    for_you_home: { type: 'string', description: 'AI/TECH STORIES ONLY: one concrete example of what a person at home could do with this development. Empty string otherwise.' },
    for_you_work: { type: 'string', description: 'AI/TECH STORIES ONLY: one concrete example of what a working professional could do with this development. Empty string otherwise.' },
    terror_summary: { type: 'string', description: 'One to two sentences max, in the exact voice described in the system prompt.' },
  },
};

function corsHeaders(origin) {
  const allowed = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Vary': 'Origin',
  };
}

function json(body, status, origin) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
  });
}

// Google News RSS links are redirect pages. The older format embeds the real
// URL base64-encoded in the path — try to decode it; otherwise the fetch
// below follows redirects and meta-refresh extraction handles the rest.
function decodeGoogleNewsUrl(url) {
  const m = url.match(/news\.google\.com\/rss\/articles\/([^?/]+)/);
  if (!m) return null;
  try {
    const decoded = atob(m[1].replace(/-/g, '+').replace(/_/g, '/'));
    const urls = decoded.match(/https?:\/\/[^\x00-\x20"\\]+/g) || [];
    return urls.find((u) => !u.includes('google.com')) || null;
  } catch {
    return null;
  }
}

function stripHtml(html) {
  // Prefer the <article> element when present; fall back to <body>.
  const articleMatch = html.match(/<article[\s\S]*?<\/article>/i);
  let scope = articleMatch ? articleMatch[0] : html;
  scope = scope
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<nav[\s\S]*?<\/nav>/gi, ' ')
    .replace(/<header[\s\S]*?<\/header>/gi, ' ')
    .replace(/<footer[\s\S]*?<\/footer>/gi, ' ')
    .replace(/<aside[\s\S]*?<\/aside>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
  return scope;
}

async function fetchArticleText(url) {
  const target = decodeGoogleNewsUrl(url) || url;
  const res = await fetch(target, {
    redirect: 'follow',
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml',
    },
  });
  if (!res.ok) throw new Error(`article fetch ${res.status}`);
  let html = await res.text();

  // Google News interstitial: follow a meta-refresh or canonical link once.
  const finalHost = new URL(res.url || target).hostname;
  if (finalHost.endsWith('news.google.com')) {
    const meta = html.match(/http-equiv=["']refresh["'][^>]*url=([^"'>]+)/i)
      || html.match(/data-n-au=["']([^"']+)["']/i)
      || html.match(/<a[^>]+href=["'](https?:\/\/(?!.*google\.com)[^"']+)["']/i);
    if (meta) {
      const next = meta[1].replace(/&amp;/g, '&');
      const res2 = await fetch(next, { redirect: 'follow', headers: { 'User-Agent': 'Mozilla/5.0' } });
      if (res2.ok) html = await res2.text();
    }
  }

  const text = stripHtml(html);
  return { text: text.slice(0, MAX_ARTICLE_CHARS), resolvedUrl: res.url || target };
}

async function analyzeWithClaude(apiKey, { title, source, section, articleText, thin }) {
  const userContent = thin
    ? `The article body could not be retrieved (paywall or blocked fetch). Analyze what can honestly be said from the headline and source alone, be explicit in the summary that this is based on the headline, and keep bias_flags/missing_facts conservative.\n\nSection: ${section}\nSource: ${source}\nHeadline: ${title}`
    : `Analyze this news article.\n\nSection: ${section}\nSource: ${source}\nHeadline: ${title}\n\nArticle text (extracted from the page, may contain leftover navigation fragments — ignore those):\n\n${articleText}`;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 2000,
      system: `You are the analysis engine for Take5-AI News ("when all you have is 5 mins"). For each article you produce a T5 card: a factual summary, an honest read of the article's political lean and bias techniques, what's missing, why it matters, the conditional blocks defined in the output schema, and a Terror Summary.\n\nRules: be factual and specific; never invent facts not supported by the text; the two political "side" sentences must each be logical, emotion-free, and able to survive a fact-check; conditional fields that don't apply are empty strings.\n\n${VOICE_PROFILE}`,
      messages: [{ role: 'user', content: userContent }],
      output_config: { format: { type: 'json_schema', schema: CARD_SCHEMA } },
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`anthropic ${res.status}: ${errText.slice(0, 200)}`);
  }
  const data = await res.json();
  if (data.stop_reason === 'refusal') throw new Error('analysis declined');
  const textBlock = (data.content || []).find((b) => b.type === 'text');
  if (!textBlock) throw new Error('no text in response');
  return JSON.parse(textBlock.text);
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }
    if (request.method !== 'GET') {
      return json({ error: 'method not allowed' }, 405, origin);
    }

    const params = new URL(request.url).searchParams;
    const articleUrl = params.get('url');
    const title = (params.get('title') || '').slice(0, 300);
    const source = (params.get('source') || '').slice(0, 100);
    const section = (params.get('section') || '').slice(0, 50);

    let parsed;
    try { parsed = new URL(articleUrl); } catch { parsed = null; }
    if (!parsed || !['http:', 'https:'].includes(parsed.protocol)) {
      return json({ error: 'invalid url' }, 400, origin);
    }
    if (!env.ANTHROPIC_API_KEY) {
      return json({ error: 'worker missing ANTHROPIC_API_KEY secret' }, 500, origin);
    }

    const cacheKey = articleUrl;
    const cached = memoryCache.get(cacheKey);
    if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
      return json({ ...cached.card, cached: true }, 200, origin);
    }

    try {
      let articleText = '';
      let resolvedUrl = articleUrl;
      let thin = false;
      try {
        const fetched = await fetchArticleText(articleUrl);
        articleText = fetched.text;
        resolvedUrl = fetched.resolvedUrl;
      } catch { /* fall through to headline-only analysis */ }
      if (articleText.length < 400) thin = true;

      const card = await analyzeWithClaude(env.ANTHROPIC_API_KEY, { title, source, section, articleText, thin });
      const result = { ...card, source_url: resolvedUrl, headline_only: thin };
      memoryCache.set(cacheKey, { card: result, at: Date.now() });
      if (memoryCache.size > 500) {
        memoryCache.delete(memoryCache.keys().next().value);
      }
      return json(result, 200, origin);
    } catch (e) {
      return json({ error: String(e.message || e).slice(0, 300) }, 502, origin);
    }
  },
};
