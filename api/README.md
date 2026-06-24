# Leaderboard backend — deploy & ops (Task 4, server side)

Three files implement the server-enforced anti-cheat for the global leaderboard. They
live next to the deployed game on Vercel:

```
api/_lb.js      shared helpers (NOT a route — the leading underscore hides it)
api/top.js      GET  /api/top     → { top: [{name,score}], token }
api/submit.js   POST /api/submit  → validates, then ZADDs the score
```

Drop them into the repo's `api/` folder (alongside `public/index.html`) and push — Vercel
auto-deploys them as serverless functions. No build step, **no npm dependencies** (uses the
Upstash REST API over `fetch` and the built-in Node `crypto`).

## Environment variables (Vercel → Settings → Environment Variables)

| Var | What |
|-----|------|
| `UPSTASH_REDIS_REST_URL` | Upstash database REST URL |
| `UPSTASH_REDIS_REST_TOKEN` | Upstash REST token (read + write) |
| `LEADERBOARD_SECRET` | long random string — the token signing key. **Never** exposed to the client. Rotating it invalidates all outstanding tokens (harmless). |

Generate a secret: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`

## How it protects the board

1. **Token gate.** Every submission needs a token, and tokens are only minted by
   `GET /api/top`. You can't POST a score without first loading the board.
2. **Authentic + fresh.** The token is `payload.signature`, signed with `LEADERBOARD_SECRET`.
   Forged or off-site tokens fail the HMAC check; tokens older than 2h are rejected.
3. **One-time use.** On submit the token is burned (`SET … NX`) in Redis, so the same
   token can't be replayed/flooded.
4. **Payload integrity.** The client sends `HMAC(token, name|score|level|runMs)`; the server
   recomputes it. Any tampering with the fields in transit breaks the match.
5. **IP rate-limit.** Token-bucket (`RATE_LIMIT` submits / `RATE_WINDOW_S` seconds).
6. **Plausibility.** `level` must be 1–6, `score ≤ plausibleMax(level)` (cumulative ceiling),
   and `runMs ≥ minRunMs(level)` (too-fast = suspect).

Writes use `ZADD GT`, so a player only ever moves up to a personal best; the set is trimmed
to the top 100.

## ⚠️ TUNE THESE before relying on the score caps

In `api/_lb.js`:

```js
const PER_LEVEL_CAP   = { 1:6000, 2:6500, 3:7500, 4:8500, 5:9000, 6:12000 }; // points/level
const MIN_MS_TO_REACH = { 1:0, 2:15000, 3:35000, 4:60000, 5:90000, 6:125000 }; // ms floor
```

These are deliberately generous placeholders so honest players are never rejected. Once you
have real run data (or compute the true per-level point maxima from the scoring code), tighten
`PER_LEVEL_CAP` toward the actual ceiling and raise `MIN_MS_TO_REACH` toward realistic minimums.

> **Note on the score-cap ↔ level-lock interaction:** `plausibleMax(level)` assumes `level`
> is the highest level legitimately reached this run. That only holds once sequential 1→6
> level-lock ships (next backlog item). Until then a player can start mid-game, so keep the
> caps loose.

## Client side

`public/index.html` (game v5+) already speaks this protocol: `submitScore()` fetches a fresh
token from `/api/top`, signs the payload with Web Crypto, and POSTs `{name, score, level,
runMs, token, hmac}`. `fetchLeaderboard()` reads the `{top, token}` shape and tolerates a
legacy bare-array response, so deploying the new functions and the new HTML in either order
won't hard-break the board.

## Smoke test after deploy

```bash
# should return {"top":[...],"token":"..."}
curl -s https://YOUR-APP.vercel.app/api/top

# a hand-forged POST without a valid token must be rejected (401)
curl -s -X POST https://YOUR-APP.vercel.app/api/submit \
  -H 'Content-Type: application/json' \
  -d '{"name":"hax","score":999999,"level":6,"runMs":1,"token":"nope","hmac":"nope"}'
```
