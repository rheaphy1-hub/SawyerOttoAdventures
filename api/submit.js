// api/submit.js — accept a score only if it passes every server-side check.
// Body: { name, score, level, runMs, token, hmac }
//
// Checks (in order):
//   1. IP rate-limit (token bucket, RATE_LIMIT / RATE_WINDOW_S).
//   2. Token authenticity + freshness (HMAC over LEADERBOARD_SECRET, not expired).
//   3. One-time use (the token cannot be replayed — Redis SET NX with TTL).
//   4. Payload integrity (HMAC(token, name|score|level|runMs) matches `hmac`).
//   5. Plausibility (level 1..6, score <= plausibleMax(level), runMs >= minRunMs(level)).
// Only then is the score written (ZADD GT, so only a personal best updates).

import crypto from 'crypto';
import {
  redis, BOARD_KEY, BOARD_MAX, SECRET,
  RATE_LIMIT, RATE_WINDOW_S,
  plausibleMax, minRunMs, clampRunMs,
  cleanName, verifyToken, payloadHmacHex, timingEq,
  getIp, sendJson, configOk,
} from './_lb.js';

async function readBody(req) {
  if (req.body) return typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  let raw = '';
  for await (const chunk of req) raw += chunk;
  return raw ? JSON.parse(raw) : {};
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return sendJson(res, 405, { error: 'method' });
  if (!configOk()) return sendJson(res, 500, { error: 'leaderboard not configured' });

  let body;
  try { body = await readBody(req); } catch { return sendJson(res, 400, { error: 'bad json' }); }

  const ip = getIp(req);

  // 1) rate-limit per IP
  try {
    const rlKey = 'lb:rl:' + ip;
    const n = await redis(['INCR', rlKey]);
    if (n === 1) await redis(['EXPIRE', rlKey, String(RATE_WINDOW_S)]);
    if (n > RATE_LIMIT) return sendJson(res, 429, { error: 'slow down' });
  } catch { /* if the limiter errors, fail open on rate-limit only */ }

  // 2) token authenticity + freshness
  const token = body.token;
  if (!verifyToken(token)) return sendJson(res, 401, { error: 'bad or expired token' });

  // 3) one-time use — reject replays of the same token
  try {
    const used = 'lb:used:' + crypto.createHash('sha256').update(token).digest('hex');
    const set = await redis(['SET', used, '1', 'NX', 'EX', String(Math.ceil((2 * 60 * 60)))]);
    if (set !== 'OK') return sendJson(res, 409, { error: 'token already used' });
  } catch { return sendJson(res, 500, { error: 'store error' }); }

  // raw fields as the client signed them (sign first, sanitize after)
  const rawName = String(body.name == null ? '' : body.name);
  const score = body.score | 0;
  const level = body.level | 0;
  const runMs = clampRunMs(body.runMs);

  // 4) payload integrity — HMAC(token, name|score|level|runMs)
  const expected = payloadHmacHex(token, rawName, score, level, runMs);
  if (!timingEq(String(body.hmac || ''), expected)) {
    return sendJson(res, 400, { error: 'integrity check failed' });
  }

  // 5) plausibility
  if (level < 1 || level > 6) return sendJson(res, 400, { error: 'bad level' });
  if (score < 0 || score > plausibleMax(level)) return sendJson(res, 400, { error: 'implausible score' });
  if (runMs < minRunMs(level)) return sendJson(res, 400, { error: 'implausibly fast' });

  const name = cleanName(rawName);

  // write — ZADD GT keeps only a personal best; trim to the top BOARD_MAX
  try {
    await redis(['ZADD', BOARD_KEY, 'GT', 'CH', String(score), name]);
    await redis(['ZREMRANGEBYRANK', BOARD_KEY, '0', String(-(BOARD_MAX + 1))]);
  } catch { return sendJson(res, 500, { error: 'store error' }); }

  let rank = null;
  try {
    const rev = await redis(['ZREVRANK', BOARD_KEY, name]);
    if (rev != null) rank = (rev | 0) + 1;
  } catch { /* rank is best-effort */ }

  return sendJson(res, 200, { ok: true, rank });
}
