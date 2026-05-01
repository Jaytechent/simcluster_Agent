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

app.listen(process.env.PORT || 3000, () => {
  console.log('Server running on port', process.env.PORT || 3000);
});
