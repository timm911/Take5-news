# Take5-AI News

**When all you have is 5 mins.**

A single-page news site: ten sections, five headlines each, all pulled live from
Google News. A "24"-style green digital clock counts down from **05:00** at the
top of the screen — when it hits **00:00**, every section swaps to fresh
up-to-the-minute stories and the countdown restarts. Forever.

## How it works

- **No backend, no build step** — pure static HTML/CSS/JS.
- Each section merges several sources: a Google News feed plus direct
  publisher RSS feeds (BBC, NPR, The Guardian, NYT, CNBC, MarketWatch,
  The Verge, Ars Technica, TechCrunch, MIT Tech Review, VentureBeat, OpenAI,
  ScienceDaily, NASA, Nature, STAT, BBC Sport, Sky Sports, Variety, The
  Hollywood Reporter). Items are merged newest-first across sources, deduped
  by title, and publisher links go straight to the article.
- The Hacker News section uses HN's official CORS-open API directly — no
  relay involved.
- Browsers can't fetch RSS cross-origin, so requests go through
  [rss2json](https://rss2json.com) (primary) with
  [AllOrigins](https://allorigins.win) as an XML fallback.
- Fetches are **paced, not burst**: the relays rate-limit rapid request
  streams, so each cycle's ~35 feed pulls are spread evenly across the
  5-minute window (a few per minute, alternating between the two relays),
  harvested into per-section pools, and swapped in together at 00:00. The
  launch order rotates each cycle so no section is ever systematically last.
  Feed URLs carry a per-cycle cache-busting token so the relays re-pull from
  the publisher every time instead of serving a cached copy.
- Each section keeps a pool of up to 15 stories and **rotates**: at every swap
  it shows five stories that weren't on screen last cycle (brand-new stories
  always jump the queue), so the links visibly change at every zero.
- Results are cached in `localStorage` — if every relay is down, the last known
  stories stay up and the clock keeps cycling. The page never blanks.
- The timer is deadline-based (computed from an absolute timestamp), so it
  never drifts, and it catches up correctly when the tab was backgrounded.

## Sections

Top Stories · World · U.S. · Business · Technology · AI · Hacker News ·
Science · Health · Sports · Entertainment

## T5 analysis cards

With the optional backend deployed (see [T5-SETUP.md](T5-SETUP.md)), clicking
a headline opens a **T5 card**: an AI analysis of the article — 4–5 sentence
summary, political lean meter, bias flags, missing facts, "So what?", the
two-sided logic block on political stories, a hypocrisy check on
celebrity/politician stories, practical what-you-can-do-with-it examples on AI
stories, and the **Terror Summary** (one deadpan sentence in the site owner's
voice). The source name under each headline links straight to the article.
Until the backend is configured, headlines link directly as before.

## Local development

```sh
python3 -m http.server 8000
# open http://localhost:8000
```

**Fast cycle for testing:** append `?debug=N` to run N-second cycles instead of
5 minutes, e.g. `http://localhost:8000/?debug=15`.

## Deployment (GitHub Pages)

The site is plain static files at the repo root — no build step — so GitHub
Pages can serve it directly from the branch.

**One-time setup:** in the repo go to **Settings → Pages → Build and
deployment**, set **Source: Deploy from a branch**, pick the branch (and
folder `/ (root)`), and save. A minute later the site is live at
<https://timm911.github.io/take5-news/>.
