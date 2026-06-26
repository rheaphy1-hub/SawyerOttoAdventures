// /api/submit  — validates a signed token + payload HMAC, then records the score.
// Zero dependencies. Env: KV_REST_API_URL, KV_REST_API_TOKEN, LEADERBOARD_SECRET
const crypto = require('node:crypto');

const URL   = process.env.KV_REST_API_URL   || process.env.UPSTASH_REDIS_REST_URL;
const TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const SECRET = process.env.LEADERBOARD_SECRET || 'dev-secret';
const KEY = 'sawyer_otto_board';

async function redis(cmd){
  const r = await fetch(URL, {
    method:'POST',
    headers:{ Authorization:`Bearer ${TOKEN}`, 'Content-Type':'application/json' },
    body: JSON.stringify(cmd)
  });
  const j = await r.json();
  if(!r.ok || j.error) throw new Error('redis: ' + (j.error || r.status));
  return j.result;
}

function safeEq(a, b){
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
function tokenValid(token){
  const i = String(token).indexOf('.');
  if(i < 0) return false;
  const exp = token.slice(0, i), sig = token.slice(i + 1);
  if(!/^\d+$/.test(exp) || Number(exp) < Date.now()) return false;
  const want = crypto.createHmac('sha256', SECRET).update(exp).digest('hex');
  return safeEq(sig, want);
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control','no-store');
  try{
    if(req.method !== 'POST'){ res.status(405).json({ error:'POST only' }); return; }
    if(!URL || !TOKEN){ res.status(500).json({ error:'missing KV env vars' }); return; }

    let b = req.body;
    if(typeof b === 'string'){ try{ b = JSON.parse(b); }catch(_){ b = {}; } }
    b = b || {};

    let { name, score, level, runMs, token, hmac } = b;
    name  = String(name || '').replace(/[^\x20-\x7E]/g,'').replace(/\s+/g,' ').trim().slice(0,20) || 'Anon';
    score = Math.max(0, Math.min(10000000, Number(score) | 0));
    level = Math.max(1, Math.min(6, Number(level) | 0));
    runMs = Math.max(0, Number(runMs) | 0);

    if(!tokenValid(token)){ res.status(403).json({ error:'bad or expired token' }); return; }

    // Payload HMAC is keyed by the token string (matches client hmacHex()).
    const want = crypto.createHmac('sha256', String(token))
      .update(`${name}|${score}|${level}|${runMs}`).digest('hex');
    if(!safeEq(hmac, want)){ res.status(403).json({ error:'hmac mismatch' }); return; }

    // GT = keep the player's highest score only.
    await redis(['ZADD', KEY, 'GT', 'CH', score, name]);
    res.status(200).json({ ok:true });
  }catch(e){
    res.status(500).json({ error: String(e && e.message || e) });
  }
};
