require("dotenv").config();

const express                          = require('express');
const { getToken, saveToken }          = require('./tokenStore');
const { startScheduler, activateSlot } = require('./scheduler');
const { resolveSlot }                  = require('./slotCodes');
const { runHeartbeat }                 = require('./heartbeat');

const app = express();
app.use(express.json());
app.use(express.static('public'));

// scheduler handles all slots internally — no args needed
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
    activateSlot(slot, true); // fire immediately for newly connected slot
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

    // normalize line endings
    const norm  = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

    // try to extract dynamically
    const match = norm.match(/remember ([^;\n]+);[^\n]*that is this edition.{0,3}s retained words/i);
    let ack = match ? match[1].trim() : null;

    // fallback to known phrase if regex fails (Render IP may get different response)
    if (!ack) {
      console.warn('[skill] regex failed — using known fallback ack. First 200 chars:', text.slice(0, 200));
      ack = 'prevent.trap.length.horse';
    }

    console.log('[skill] hash:', hash.slice(0, 16) + '... | ack:', ack);
    res.json({ success: true, text, hash, ack });
  } catch (err) {
    console.error('[skill] fetch error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// // GET /api/skill — fetch skill.md, compute hash, extract ack phrase dynamically
// app.get('/api/skill', async (req, res) => {
//   try {
//     const r    = await fetch('https://simcluster.ai/skill.md');
//     const text = await r.text();

//     const crypto = require('crypto');
//     const hash   = crypto.createHash('sha256').update(text, 'utf8').digest('hex');

//     // Pattern: "remember X; that is this edition's retained words"
//     const match = text.match(/remember ([^;\n]+);\s*that is this edition[''']s retained words/i);
//     const ack   = match ? match[1].trim() : null;

//     if (!ack) {
//       console.error('[skill] ack phrase not found in skill.md — file may have rotated');
//       return res.status(500).json({ success: false, error: 'ack phrase not found in skill.md' });
//     }

//     console.log('[skill] hash:', hash.slice(0, 16) + '... | ack:', ack);
//     res.json({ success: true, text, hash, ack });
//   } catch (err) {
//     console.error('[skill] fetch error:', err.message);
//     res.status(500).json({ success: false, error: err.message });
//   }
// });

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
// Protected by X-Run-Secret header matching RUN_SECRET env var
app.post('/api/run-all', async (req, res) => {
  const { loadSkillHeaders } = require('./heartbeat');
  const { TOTAL_SLOTS }      = require('./slotCodes');

  // load skill headers once for all slots
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


// require("dotenv").config();

// const express                      = require('express');
// const { getToken, saveToken }      = require('./tokenStore');
// const { startScheduler, activateSlot } = require('./scheduler');
// const { resolveSlot }              = require('./slotCodes');
// const { runHeartbeat }             = require('./heartbeat');

// const app = express();
// app.use(express.json());
// app.use(express.static('public'));

// startScheduler(() => getToken()); 

// // POST /api/exchange  { code, accessCode }
// app.post('/api/exchange', async (req, res) => {
//   const { code, accessCode } = req.body;
//   if (!code)       return res.status(400).json({ error: 'Missing simcluster code' });
//   if (!accessCode) return res.status(400).json({ error: 'Missing access code' });

//   const slot = resolveSlot(accessCode);
//   if (!slot) return res.status(403).json({ error: 'Invalid access code' });

//   try {
//     const r = await fetch('https://simcluster.ai/api/agent/session/exchange-code', {
//       method: 'POST',
//       headers: { 'Content-Type': 'application/json' },
//       body: JSON.stringify({ code }),
//     });
//     const data  = await r.json();
//     const token = data?.bearerToken || data?.token;
//     if (!token) {
//       console.error('[exchange] slot', slot, 'no token:', data);
//       return res.status(500).json({ error: 'No token returned from Simcluster', full: data });
//     }
//     saveToken(slot, token);
//     activateSlot(slot);
//     console.log('[exchange] slot', slot, 'connected');
//     res.json({ success: true, slot });
//   } catch (err) {
//     res.status(500).json({ error: err.message });
//   }
// });


// // GET /api/skill  — proxy skill.md and return text + hash + ack phrase
// app.get('/api/skill', async (req, res) => {
//   try {
//     const r    = await fetch('https://simcluster.ai/skill.md');
//     const text = await r.text();

//     const crypto = require('crypto');
//     const hash   = crypto.createHash('sha256').update(text).digest('hex');

//     // find every line that looks like an acknowledgement phrase
//     const ackLines = (text.match(/^I [^\n]{10,}/gm) || []).map(l => l.trim());

//     res.json({ success: true, text, hash, ackLines });
//   } catch (err) {
//     res.status(500).json({ success: false, error: err.message });
//   }
// });

// // POST /api/run  { accessCode }
// app.post('/api/run', async (req, res) => {
//   const { accessCode } = req.body;
//   if (!accessCode) return res.status(400).json({ error: 'Missing access code' });

//   const slot = resolveSlot(accessCode);
//   if (!slot) return res.status(403).json({ error: 'Invalid access code' });

//   const token = getToken(slot);
//   if (!token) {
//     return res.status(401).json({
//       success: false,
//       error: 'No bearer token for this slot. Complete onboarding first.',
//     });
//   }

//   const { skillHash, skillAck } = req.body || {};
//   if (!skillHash || !skillAck) {
//     return res.status(400).json({ success: false, error: 'skill hash/ack missing — acknowledge skill.md in the dashboard first' });
//   }

//   try {
//     const { logs, result } = await runHeartbeat(token, skillHash, skillAck);
//     res.json({ success: true, slot, logs, result });
//   } catch (err) {
//     console.error('[run] slot', slot, 'error:', err.message);
//     res.status(500).json({ success: false, error: err.message, logs: ['[FATAL] ' + err.message] });
//   }
// });

// // GET /status?accessCode=...
// app.get('/status', (req, res) => {
//   const { accessCode } = req.query;
//   if (!accessCode) return res.json({ hasToken: false });
//   const slot = resolveSlot(accessCode);
//   if (!slot) return res.json({ hasToken: false, error: 'Invalid access code' });
//   res.json({ hasToken: !!getToken(slot), slot });
// });


// // Manual heartbeat trigger
// // ─────────────────────────────────────────────────────────────────────────────

// app.post('/api/run', async (req, res) => {
//   const token = getToken();

//   if (!token) {
//     return res.status(401).json({
//       success: false,
//       error: 'No bearer token stored. Complete onboarding first.',
//     });
//   }

//   try {
//     const { logs, result } = await runHeartbeat(token);
//     res.json({ success: true, logs, result });
//   } catch (err) {
//     console.error('Heartbeat error:', err);
//     res.status(500).json({
//       success: false,
//       error: err.message,
//       logs: [`[FATAL] ${err.message}`],
//     });
//   }
// });

// app.listen(process.env.PORT || 3000, () => {
//   console.log('Server running on port', process.env.PORT || 3000);
// });
