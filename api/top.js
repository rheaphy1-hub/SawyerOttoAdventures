// /api/top  — returns the top scores + a short-lived signed token for /api/submit.
const crypto = require('node:crypto');

const URL   = process.env.KV_REST_API_URL   || process.env.UPSTASH_REDIS_REST_URL;
const TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const SECRET = process.env.LEADERBOARD_SECRET || 'dev-secret';
const KEY = 'sawyer_otto_board';
const TOP_N = 10;

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

function mintToken(){
  const exp = Date.now() + 120000;               // valid 2 minutes
  const sig = crypto.createHmac('sha256', SECRET).update(String(exp)).digest('hex');
  return `${exp}.${sig}`;
}

module.exports = async (req, res) => {
  cors(res);
  res.setHeader('Cache-Control','no-store');
  if(req.method === 'OPTIONS'){ res.status(204).end(); return; }   // preflight
  try{
    if(!URL || !TOKEN){
      res.status(500).json({ error:'missing KV_REST_API_URL / KV_REST_API_TOKEN' });
      return;
    }
    const flat = await redis(['ZRANGE', KEY, 0, TOP_N - 1, 'REV', 'WITHSCORES']) || [];
    const top = [];
    for(let i=0; i<flat.length; i+=2){
      top.push({ name: String(flat[i]), score: Number(flat[i+1]) || 0 });
    }
    res.status(200).json({ top, token: mintToken() });
  }catch(e){
    res.status(500).json({ error: String(e && e.message || e) });
  }
};
