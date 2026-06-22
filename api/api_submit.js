// /api/submit.js — POST { name, score } -> stores in Upstash sorted set.
// Env vars (auto-injected by the Vercel Upstash/KV integration):
//   KV_REST_API_URL, KV_REST_API_TOKEN
// Keeps only the player's best score (sorted set: member=name, score=points).

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'POST only' });
    return;
  }

  const URL = process.env.KV_REST_API_URL;
  const TOKEN = process.env.KV_REST_API_TOKEN;
  if (!URL || !TOKEN) {
    res.status(500).json({ error: 'Leaderboard not configured' });
    return;
  }

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }

  // Sanitize
  let name = String((body && body.name) || '').replace(/[^\x20-\x7E]/g, '').replace(/\s+/g, ' ').trim().slice(0, 16);
  if (!name) name = 'Anonymous';
  let score = parseInt((body && body.score), 10);
  if (!Number.isFinite(score) || score < 0) score = 0;
  if (score > 1000000) score = 1000000; // sane cap

  // Unique member so identical names don't overwrite each other.
  const member = name + '#' + Math.random().toString(36).slice(2, 7);

  try {
    // ZADD leaderboard <score> <member>
    const r = await fetch(`${URL}/zadd/leaderboard/${score}/${encodeURIComponent(member)}`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    if (!r.ok) throw new Error('upstash zadd failed');
    res.status(200).json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'store failed' });
  }
}
