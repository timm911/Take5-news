# T5 Analysis Card — Backend Setup

Clicking a headline opens the **T5 card**: an AI analysis of the article
(summary, political lean, bias flags, missing facts, "So what?", and the
Terror Summary), generated on demand by a Cloudflare Worker calling Claude.

The site works without this — headlines just link straight to articles until
the backend is wired up.

## One-time setup (~10 minutes, all in the browser)

### 1. Get an Anthropic API key

1. Go to <https://console.anthropic.com> and sign in / create an account.
2. Add a small amount of credit (a few dollars covers thousands of cards).
3. **API Keys → Create Key**. Copy it — it's shown once.

### 2. Create the Cloudflare Worker

1. Go to <https://dash.cloudflare.com> (free account is fine).
2. **Workers & Pages → Create → Create Worker**. Give it a name like
   `take5-t5`, then **Deploy** the starter.
3. Click **Edit code**, delete the starter code, and paste in the entire
   contents of [`worker/worker.js`](worker/worker.js) from this repo.
   **Deploy**.
4. Back on the worker's page: **Settings → Variables and Secrets → Add**.
   Type: **Secret**. Name: `ANTHROPIC_API_KEY`. Value: the key from step 1.
   Save (and redeploy if prompted).
5. Copy the worker's URL — it looks like
   `https://take5-t5.<your-subdomain>.workers.dev`.

### 3. Wire the site to the worker

Set `T5_API_DEFAULT` at the top of [`app.js`](app.js) to the worker URL from
step 2.5 and push — or hand the URL to whoever maintains the repo.

To test before committing, open the site with the override parameter:
`https://timm911.github.io/Take5-news/?t5api=https://take5-t5.<subdomain>.workers.dev`

## Notes

- **Cost**: each *new* article analyzed costs a few cents (Claude Opus 4.8);
  results are cached in the worker and in each reader's browser, so repeat
  clicks are free. The first click on a story takes ~10–20 seconds; cached
  cards open instantly.
- **Security**: the API key lives only in the worker's secret store — it never
  appears in the site code or in browsers. The worker only accepts requests
  from the site's origin.
- **Model**: set in `worker/worker.js` (`MODEL`). `claude-opus-4-8` gives the
  sharpest analysis; `claude-haiku-4-5` is ~5× cheaper and faster with lighter
  analysis.
