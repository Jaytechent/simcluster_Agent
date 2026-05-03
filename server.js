require("dotenv").config();

const express                          = require('express');
const { getToken, saveToken }          = require('./tokenStore');
const { startScheduler, activateSlot } = require('./scheduler');
const { resolveSlot }                  = require('./slotCodes');
const { runHeartbeat }                 = require('./heartbeat');

const app = express();
app.use(express.json());
app.use(express.static('public'));

startScheduler();

// POST /api/exchange  { code, accessCode }
app.post('/api/exchange', async (req, res) => {
  const { code, accessCode } = req.body;
  if (!code)       return res.status(400).json({ error: 'Missing simcluster code' });
  if (!accessCode) return res.status(400).json({ error: 'Missing access code' });

  const slot = resolveSlot(accessCode);
  if (!slot) return res.status(403).json({ error: 'Invalid access code' });

  try {
    const r = await fetch('https://simcluster.ai/api/agent/session/exchange-code', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
    });
    const data  = await r.json();
    const token = data?.bearerToken || data?.token;
    if (!token) {
      console.error('[exchange] slot', slot, 'no token:', data);
      return res.status(500).json({ error: 'No token returned from Simcluster', full: data });
    }
    saveToken(slot, token);
    activateSlot(slot, true);
    console.log('[exchange] slot', slot, 'connected');
    res.json({ success: true, slot });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/skill — fetch skill.md, compute hash, extract ack phrase
app.get('/api/skill', async (req, res) => {
  try {
    const r = await fetch('https://simcluster.ai/skill.md', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/plain, text/markdown, */*',
        'Accept-Language': 'en-US,en;q=0.9',
      }
    });

    const text = await r.text();
    const crypto = require('crypto');
    const hash   = crypto.createHash('sha256').update(text, 'utf8').digest('hex');

    const norm = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

    // FIX 1: use `let` so the fallback assignment below doesn't crash
    // FIX 2: try the CURRENT skill.md format first (retain "..." as their carry-forward words)
    //        then fall back to the old format (remember "..."; that is this edition)
    let ack = null;

    const matchNew = norm.match(/retain\s+["'`]?([^"'`\n]+?)["'`]?\s+as\s+their\s+carry-forward/i);
    if (matchNew) {
      ack = matchNew[1].trim().replace(/^[`'"]+|[`'"]+$/g, '').trim();
    }

    if (!ack) {
      const matchOld = norm.match(/remember\s+[`"']?([^;`"'\n]+)[`"']?;[^\n]*that is this edition/i);
      if (matchOld) ack = matchOld[1].trim().replace(/^[`'"]+|[`'"]+$/g, '').trim();
    }

    // FIX 3: updated fallback phrase to match current skill.md edition
    if (!ack) {
      console.warn('[skill] regex failed — using known fallback ack. First 200 chars:', text.slice(0, 200));
      ack = 'need.wish.file.palm.seek';
    }

    console.log('[skill] hash:', hash.slice(0, 16) + '... | ack:', ack);
    res.json({ success: true, text, hash, ack });
  } catch (err) {
    console.error('[skill] fetch error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/run  { accessCode, skillHash, skillAck }
app.post('/api/run', async (req, res) => {
  const { accessCode, skillHash, skillAck } = req.body || {};

  if (!accessCode) return res.status(400).json({ error: 'Missing access code' });

  const slot = resolveSlot(accessCode);
  if (!slot) return res.status(403).json({ error: 'Invalid access code' });

  const token = getToken(slot);
  if (!token) {
    return res.status(401).json({
      success: false,
      error: 'No bearer token for this slot. Complete onboarding first.',
    });
  }

  if (!skillHash || !skillAck) {
    return res.status(400).json({
      success: false,
      error: 'skill hash/ack missing — acknowledge skill.md in the dashboard first',
    });
  }

  try {
    const { logs, result } = await runHeartbeat(token, skillHash, skillAck);
    res.json({ success: true, slot, logs, result });
  } catch (err) {
    console.error('[run] slot', slot, 'error:', err.message);
    res.status(500).json({ success: false, error: err.message, logs: ['[FATAL] ' + err.message] });
  }
});

// POST /api/run-all  — fire all active slots (for cron/CI use)
app.post('/api/run-all', async (req, res) => {
  const { loadSkillHeaders } = require('./heartbeat');
  const { TOTAL_SLOTS }      = require('./slotCodes');

  let skillHash, skillAck;
  try {
    ({ skillHash, skillAck } = await loadSkillHeaders());
  } catch (err) {
    return res.status(500).json({ success: false, error: 'skill load failed: ' + err.message });
  }

  const results = [];

  for (let i = 1; i <= TOTAL_SLOTS; i++) {
    const token = getToken(i);
    if (!token) {
      results.push({ slot: i, skipped: 'no token' });
      continue;
    }
    try {
      console.log('[run-all] firing slot', i);
      const { logs, result } = await runHeartbeat(token, skillHash, skillAck);
      results.push({ slot: i, success: true, result });
    } catch (err) {
      console.error('[run-all] slot', i, 'error:', err.message);
      results.push({ slot: i, success: false, error: err.message });
    }
  }

  res.json({ success: true, results });
});

// GET /status?accessCode=...
app.get('/status', (req, res) => {
  const { accessCode } = req.query;
  if (!accessCode) return res.json({ hasToken: false });
  const slot = resolveSlot(accessCode);
  if (!slot) return res.json({ hasToken: false, error: 'Invalid access code' });
  res.json({ hasToken: !!getToken(slot), slot });
});

// ── Manual API helpers ────────────────────────────────────────────────────────
const crypto = require('crypto');

function makeManualRpc(token, skillHash, skillAck) {
  let _id = 1;
  return async function rpc(name, args = {}) {
    const id = _id++;
    const r  = await fetch('https://simcluster.ai/mcp', {
      method:  'POST',
      headers: {
        'Authorization':           'Bearer ' + token,
        'Content-Type':            'application/json',
        'Accept':                  'application/json, text/event-stream',
        'X-Simcluster-Skill-Hash': skillHash,
        'X-Simcluster-Skill-Ack':  skillAck,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }),
    });
    const j = await r.json();
    if (j.result?.isError) throw new Error(`${name}: ${j.result.content?.[0]?.text || 'unknown'}`);
    if (j.error)           throw new Error(`${name}: ${j.error.message}`);
    const txt = j.result?.content?.[0]?.text;
    if (!txt) return j.result;
    try { return JSON.parse(txt); } catch { return txt; }
  };
}

function buildItems(conceptIds) {
  const entries = conceptIds.map(s => ({ type: 'concept', shortId: s }));
  const items   = [];
  entries.forEach((e, i) => {
    items.push(e);
    if (i < entries.length - 1) items.push({ type: 'fragment', fragment: null });
  });
  return items;
}

const FPNAP       = 'eNXWgYAn';
const HAVEN_SHORT = '025YY6a2';

function resolveConceptIds(raw) {
  if (raw && raw.trim()) {
    return raw.split(',').map(s => s.trim()).filter(Boolean);
  }
  return [FPNAP, HAVEN_SHORT];
}

// POST /api/manual/text  { accessCode, skillHash, skillAck, concepts, caption }
app.post('/api/manual/text', async (req, res) => {
  const { accessCode, skillHash, skillAck, concepts, caption } = req.body || {};
  if (!accessCode) return res.status(400).json({ success: false, error: 'Missing access code' });
  const slot  = resolveSlot(accessCode);
  if (!slot)  return res.status(403).json({ success: false, error: 'Invalid access code' });
  const token = getToken(slot);
  if (!token) return res.status(401).json({ success: false, error: 'No bearer token — connect first' });

  const conceptIds = resolveConceptIds(concepts);
  const rpc = makeManualRpc(token, skillHash, skillAck);

  try {
    const args = { items: buildItems(conceptIds), mediaShortIds: [] };
    if (caption) args.text = caption;
    const data = await rpc('create.text', args);
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/manual/image  { accessCode, skillHash, skillAck, concepts, caption }
app.post('/api/manual/image', async (req, res) => {
  const { accessCode, skillHash, skillAck, concepts, caption } = req.body || {};
  if (!accessCode) return res.status(400).json({ success: false, error: 'Missing access code' });
  const slot  = resolveSlot(accessCode);
  if (!slot)  return res.status(403).json({ success: false, error: 'Invalid access code' });
  const token = getToken(slot);
  if (!token) return res.status(401).json({ success: false, error: 'No bearer token — connect first' });

  const conceptIds = resolveConceptIds(concepts);
  const rpc = makeManualRpc(token, skillHash, skillAck);
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  try {
    const k = await rpc('create.image', { items: buildItems(conceptIds), aspectRatio: '1:1' });
    const evtId = k.generation_event_id;
    if (!evtId) throw new Error('No generation_event_id: ' + JSON.stringify(k));

    let mediaShortId = null;
    for (let i = 0; i < 60; i++) {
      await sleep(3000);
      const st = await rpc('create.getGenerationStatus', { generation_event_id: evtId });
      if (st.status === 'complete' || st.status === 'completed') {
        mediaShortId = st.mediaShortId || st.media?.shortId || st.media?.short_id || null;
        break;
      }
      if (st.status === 'failed' || st.status === 'error') throw new Error('Image gen failed: ' + JSON.stringify(st));
    }
    if (!mediaShortId) throw new Error('Image generation timed out');

    const postArgs = { items: buildItems(conceptIds), mediaShortIds: [mediaShortId] };
    if (caption) postArgs.text = caption;
    const data = await rpc('create.text', postArgs);
    res.json({ success: true, data, mediaShortId });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/manual/bonus  { accessCode, skillHash, skillAck, type: 'signin'|'billboard' }
app.post('/api/manual/bonus', async (req, res) => {
  const { accessCode, skillHash, skillAck, type } = req.body || {};
  if (!accessCode) return res.status(400).json({ success: false, error: 'Missing access code' });
  const slot  = resolveSlot(accessCode);
  if (!slot)  return res.status(403).json({ success: false, error: 'Invalid access code' });
  const token = getToken(slot);
  if (!token) return res.status(401).json({ success: false, error: 'No bearer token — connect first' });

  const rpc = makeManualRpc(token, skillHash, skillAck);
  try {
    let data, message;
    if (type === 'signin') {
      data = await rpc('bounties.claimDailySignInBounty', {});
      message = 'Sign-in bonus claimed';
    } else if (type === 'billboard') {
      data = await rpc('bounties.claimDailyBillboardBonus', {});
      message = 'Billboard bonus claimed';
    } else {
      return res.status(400).json({ success: false, error: 'Invalid bonus type — use signin or billboard' });
    }
    res.json({ success: true, message, data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/manual/repost  { accessCode, skillHash, skillAck }
app.post('/api/manual/repost', async (req, res) => {
  const { accessCode, skillHash, skillAck } = req.body || {};
  if (!accessCode) return res.status(400).json({ success: false, error: 'Missing access code' });
  const slot  = resolveSlot(accessCode);
  if (!slot)  return res.status(403).json({ success: false, error: 'Invalid access code' });
  const token = getToken(slot);
  if (!token) return res.status(401).json({ success: false, error: 'No bearer token — connect first' });

  const rpc = makeManualRpc(token, skillHash, skillAck);
  try {
    const feed = await rpc('feed.forYou', { limit: 5 });
    const posts = Array.isArray(feed) ? feed : (feed?.posts || feed?.items || []);
    if (!posts.length) return res.json({ success: false, error: 'No posts in feed to repost' });
    const target = posts[0];
    const postId = target.shortId || target.short_id || target.id;
    if (!postId) return res.json({ success: false, error: 'Could not find post ID in feed' });
    const data = await rpc('create.repost', { postShortId: postId });
    res.json({ success: true, data, repostedId: postId });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, '0.0.0.0', () => {
  console.log('Server running on port', PORT);
});
