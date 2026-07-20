# Take5-AI News

**When all you have is 5 mins.**

A single-page news site: ten sections, five headlines each, all pulled live from
Google News. A "24"-style green digital clock counts down from **05:00** at the
top of the screen — when it hits **00:00**, every section swaps to fresh
up-to-the-minute stories and the countdown restarts. Forever.

## How it works

- **No backend, no build step** — pure static HTML/CSS/JS.
- Each section maps to a Google News RSS feed (topic feeds, plus a search feed
  for the AI section).
- Browsers can't fetch RSS cross-origin, so requests go through
  [rss2json](https://rss2json.com) (primary) with
  [AllOrigins](https://allorigins.win) as an XML fallback.
- ~15 seconds before zero the page **prefetches** all ten feeds so the swap at
  00:00 is instant.
- Results are cached in `localStorage` — if every relay is down, the last known
  stories stay up and the clock keeps cycling. The page never blanks.
- The timer is deadline-based (computed from an absolute timestamp), so it
  never drifts, and it catches up correctly when the tab was backgrounded.

## Sections

Top Stories · World · U.S. · Business · Technology · AI · Science · Health ·
Sports · Entertainment

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
