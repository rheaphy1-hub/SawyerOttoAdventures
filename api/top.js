// /api/top.js — GET -> top 10 scores as [{ name, score }, ...] (desc).
// Env vars: KV_REST_API_URL, KV_REST_API_TOKEN (Vercel Upstash/KV integration).

export default async function handler(req, res) {
  const URL = process.env.KV_REST_API_URL;
  const TOKEN = process.env.KV_REST_API_TOKEN;
  if (!URL || !TOKEN) {
    res.status(500).json({ error: 'Leaderboard not configured' });
    return;
  }

  try {
    // ZRANGE leaderboard 0 9 REV WITHSCORES  -> highest first
    const r = await fetch(`${URL}/zrange/leaderboard/0/9/rev/withscores`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    if (!r.ok) throw new Error('upstash zrange failed');
    const data = await r.json();
    const arr = (data && data.result) || [];

    // Flat array: [member, score, member, score, ...]
    const out = [];
    for (let i = 0; i < arr.length; i += 2) {
      const member = String(arr[i] || '');
      const name = member.split('#')[0] || '???'; // strip unique suffix
      out.push({ name, score: parseInt(arr[i + 1], 10) || 0 });
    }

    res.setHeader('Cache-Control', 's-maxage=10, stale-while-revalidate=30');
    res.status(200).json(out);
  } catch (e) {
    res.status(500).json({ error: 'fetch failed' });
  }
}
