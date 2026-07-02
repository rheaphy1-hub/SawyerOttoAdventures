// /api/submit  — validates a signed token + payload HMAC, then records the score.
const crypto = require('node:crypto');

const URL   = process.env.KV_REST_API_URL   || process.env.UPSTASH_REDIS_REST_URL;
const TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const SECRET = process.env.LEADERBOARD_SECRET || 'dev-secret';
const KEY = 'sawyer_otto_board';

// Plausibility cap. 300000 is generous headroom over a best legit run (~150k).
// At 10000000, a spoofed entry could permanently top the board.
const MAX_SCORE = 300000;

// Authoritative name blocklist. Runs AFTER HMAC verify to catch API bypasses.
// The nameAllowed() function collapses leet-speak (4→a, 3→e, 1→i, 0→o, 5→s, 7→t)
// so 'ass' also catches 'a$$', '4ss', 'a55', etc. without listing every variant.
const BANNED = [
  'ass', 'bitch', 'bastard', 'crap', 'damn', 'dammit', 'dick', 'dumb', 'fart', 'fk', 'frick', 'fuck', 'gd', 'hell', 'horny', 'kkk', 'nazi', 'piss', 'porn', 'prick', 'shit', 'slut', 'suck', 'tit', 'turd', 'twat', 'weed', 'xxx'
];

function nameAllowed(name){
  const folded = String(name).toLowerCase()
    .replace(/[4@]/g,'a').replace(/3/g,'e').replace(/[1!|]/g,'i')
    .replace(/0/g,'o').replace(/[5$]/g,'s').replace(/7/g,'t')
    .replace(/[^a-z]/g,'');                 // collapse spacing/symbols/leet evasion
  return !BANNED.some(w => w && folded.includes(w));
}

function cors(res){
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

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
  cors(res);
  res.setHeader('Cache-Control','no-store');
  if(req.method === 'OPTIONS'){ res.status(204).end(); return; }   // preflight
  try{
    if(req.method !== 'POST'){ res.status(405).json({ error:'POST only' }); return; }
    if(!URL || !TOKEN){ res.status(500).json({ error:'missing KV env vars' }); return; }

    let b = req.body;
    if(typeof b === 'string'){ try{ b = JSON.parse(b); }catch(_){ b = {}; } }
    b = b || {};

    let { name, score, level, runMs, token, hmac } = b;
    name  = String(name || '').replace(/[^\x20-\x7E]/g,'').replace(/\s+/g,' ').trim().slice(0,20) || 'Anon';
    score = Math.max(0, Math.min(MAX_SCORE, Number(score) | 0));
    level = Math.max(1, Math.min(6, Number(level) | 0));
    runMs = Math.max(0, Number(runMs) | 0);

    if(!tokenValid(token)){ res.status(403).json({ error:'bad or expired token' }); return; }

    // Payload HMAC is keyed by the token string (matches client hmacHex()).
    const want = crypto.createHmac('sha256', String(token))
      .update(`${name}|${score}|${level}|${runMs}`).digest('hex');
    if(!safeEq(hmac, want)){ res.status(403).json({ error:'hmac mismatch' }); return; }

    // Banned name -> store the score under a safe fallback (score still counts).
    if(!nameAllowed(name)){ name = 'Anon'; }

    await redis(['ZADD', KEY, 'GT', 'CH', score, name]);
    res.status(200).json({ ok:true });
  }catch(e){
    res.status(500).json({ error: String(e && e.message || e) });
  }
};
