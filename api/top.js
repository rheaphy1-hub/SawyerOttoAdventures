// api/top.js — GET the leaderboard and mint a short-lived signed session token.
// Response: { top: [{name, score}, ...], token: "<opaque>" }
// The token is required by /api/submit; it is opaque to the client and signed
// with LEADERBOARD_SECRET so it cannot be forged or minted off-site.

import { redis, BOARD_KEY, TOP_N, makeToken, getIp, sendJson, configOk } from './_lb.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') return sendJson(res, 405, { error: 'method' });
  if (!configOk()) return sendJson(res, 500, { error: 'leaderboard not configured' });

  let top = [];
  try {
    const flat = await redis(['ZREVRANGE', BOARD_KEY, '0', String(TOP_N - 1), 'WITHSCORES']);
    for (let i = 0; i < flat.length; i += 2) {
      top.push({ name: flat[i], score: Number(flat[i + 1]) | 0 });
    }
  } catch (e) {
    // board read failed — still hand back an empty list + a token so the client renders
    top = [];
  }

  const token = makeToken(getIp(req));
  return sendJson(res, 200, { top, token });
}
