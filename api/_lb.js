// api/_lb.js — shared leaderboard helpers (filename prefixed with "_" so Vercel
// does NOT expose it as a route). Imported by api/top.js and api/submit.js.
//
// Env vars (set in Vercel → Project → Settings → Environment Variables):
//   Redis access — uses whichever your project already has:
//     KV_REST_API_URL / KV_REST_API_TOKEN        (Vercel KV / Upstash integration)
//     or UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN  (raw Upstash)
//   LEADERBOARD_SECRET — long random string, NEVER shipped to the client
//
// Zero npm dependencies: talks to the Redis REST API with fetch, signs tokens
// with the built-in Node crypto module.

import crypto from 'crypto';

const RURL = process.env.KV_REST_API_URL   || process.env.UPSTASH_REDIS_REST_URL;
const RTOK = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
export const SECRET = process.env.LEADERBOARD_SECRET || '';

export const BOARD_KEY = 'lb:board';     // sorted set: member=name, score=points
export const BOARD_MAX = 100;            // keep only the top N members
export const TOP_N     = 20;             // returned to the client
export const TOKEN_TTL_MS = 2 * 60 * 60 * 1000;  // 2h — token must be used within this
export const RATE_LIMIT = 20;            // submits allowed per IP per window
export const RATE_WINDOW_S = 60;

// ----- anti-cheat tuning tables (TUNE-ME to match real scoring) ---------------
// Per-level point ceiling; plausibleMax(level) is the cumulative sum 1..level.
// Set generously above any honest run so legit players are never rejected.
const PER_LEVEL_CAP = { 1: 6000, 2: 6500, 3: 7500, 4: 8500, 5: 9000, 6: 12000 };
// Minimum wall-clock (ms) a legit run needs to have *reached* a given level.
// A submission claiming `level` with runMs below this floor is rejected as suspect.
const MIN_MS_TO_REACH = { 1: 0, 2: 15000, 3: 35000, 4: 60000, 5: 90000, 6: 125000 };
const RUNMS_HARD_MAX = 24 * 60 * 60 * 1000; // clamp absurd clocks rather than reject

export function plausibleMax(level) {
  let sum = 0;
  for (let l = 1; l <= level; l++) sum += (PER_LEVEL_CAP[l] || 0);
  return sum;
}
export function minRunMs(level) { return MIN_MS_TO_REACH[level] || 0; }
export function clampRunMs(ms) { return Math.max(0, Math.min(ms | 0, RUNMS_HARD_MAX)); }

// ----- Upstash REST -----------------------------------------------------------
export async function redis(cmd) {
  const res = await fetch(RURL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${RTOK}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmd),
  });
  if (!res.ok) throw new Error('redis ' + res.status);
  const j = await res.json();
  if (j.error) throw new Error('redis ' + j.error);
  return j.result;
}

// ----- name hygiene (mirror of the client, but the server is authoritative) ---
export function cleanName(raw) {
  let n = String(raw || '').replace(/[^\x20-\x7E]/g, '').replace(/\s+/g, ' ').trim().slice(0, 20);
  return n || 'Anonymous';
}

// ----- session token: opaque to the client, signed with SECRET ---------------
const b64u = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
function hmac(key, msg) { return crypto.createHmac('sha256', key).update(msg).digest(); }

export function makeToken(ip) {
  const body = b64u(JSON.stringify({ n: crypto.randomBytes(9).toString('hex'), iat: Date.now(), ip }));
  const sig = b64u(hmac(SECRET, body));
  return body + '.' + sig;
}

export function verifyToken(token) {
  if (typeof token !== 'string' || token.indexOf('.') < 0) return null;
  const [body, sig] = token.split('.');
  const expected = b64u(hmac(SECRET, body));
  if (!timingEq(sig, expected)) return null;
  let p;
  try { p = JSON.parse(Buffer.from(body.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')); }
  catch { return null; }
  if (!p || typeof p.iat !== 'number') return null;
  if (Date.now() - p.iat > TOKEN_TTL_MS) return null; // expired
  return p;
}

// Per-submission integrity: client signs `name|score|level|runMs` with the token
// as the HMAC key (the token is a per-session shared secret). We recompute it.
export function payloadHmacHex(token, name, score, level, runMs) {
  return crypto.createHmac('sha256', token).update(`${name}|${score}|${level}|${runMs}`).digest('hex');
}

export function timingEq(a, b) {
  const ba = Buffer.from(String(a)); const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

export function getIp(req) {
  const xf = req.headers['x-forwarded-for'];
  if (xf) return String(xf).split(',')[0].trim();
  return req.headers['x-real-ip'] || req.socket?.remoteAddress || 'unknown';
}

export function sendJson(res, status, obj) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(obj));
}

export function configOk() { return !!(RURL && RTOK && SECRET); }
