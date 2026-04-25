require("dotenv").config();

const express                      = require('express');
const { getToken, saveToken }      = require('./tokenStore');
const { startScheduler, activateSlot } = require('./scheduler');
const { resolveSlot }              = require('./slotCodes');
const { runHeartbeat }             = require('./heartbeat');

const app = express();
app.use(express.json());
app.use(express.static('public'));

startScheduler(() => getToken()); 

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
    activateSlot(slot);
    console.log('[exchange] slot', slot, 'connected');
    res.json({ success: true, slot });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


// GET /api/skill  — proxy skill.md and return text + hash + ack phrase
app.get('/api/skill', async (req, res) => {
  try {
    const r    = await fetch('https://simcluster.ai/skill.md');
    const text = await r.text();

    const crypto = require('crypto');
    const hash   = crypto.createHash('sha256').update(text).digest('hex');

    // find every line that looks like an acknowledgement phrase
    const ackLines = (text.match(/^I [^\n]{10,}/gm) || []).map(l => l.trim());

    res.json({ success: true, text, hash, ackLines });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/run  { accessCode }
app.post('/api/run', async (req, res) => {
  const { accessCode } = req.body;
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

  const { skillHash, skillAck } = req.body || {};
  if (!skillHash || !skillAck) {
    return res.status(400).json({ success: false, error: 'skill hash/ack missing — acknowledge skill.md in the dashboard first' });
  }

  try {
    const { logs, result } = await runHeartbeat(token, skillHash, skillAck);
    res.json({ success: true, slot, logs, result });
  } catch (err) {
    console.error('[run] slot', slot, 'error:', err.message);
    res.status(500).json({ success: false, error: err.message, logs: ['[FATAL] ' + err.message] });
  }
});

// GET /status?accessCode=...
app.get('/status', (req, res) => {
  const { accessCode } = req.query;
  if (!accessCode) return res.json({ hasToken: false });
  const slot = resolveSlot(accessCode);
  if (!slot) return res.json({ hasToken: false, error: 'Invalid access code' });
  res.json({ hasToken: !!getToken(slot), slot });
});


// Manual heartbeat trigger
// ─────────────────────────────────────────────────────────────────────────────

app.post('/api/run', async (req, res) => {
  const token = getToken();

  if (!token) {
    return res.status(401).json({
      success: false,
      error: 'No bearer token stored. Complete onboarding first.',
    });
  }

  try {
    const { logs, result } = await runHeartbeat(token);
    res.json({ success: true, logs, result });
  } catch (err) {
    console.error('Heartbeat error:', err);
    res.status(500).json({
      success: false,
      error: err.message,
      logs: [`[FATAL] ${err.message}`],
    });
  }
});

app.listen(process.env.PORT || 3000, () => {
  console.log('Server running on port', process.env.PORT || 3000);
});

// require("dotenv").config();

// const express = require('express');
// const { saveToken, getToken } = require('./tokenStore');
// const startScheduler = require('./scheduler');
// const { runHeartbeat } = require('./heartbeat');

// const app = express();
// app.use(express.json());
// app.use(express.static('public'));

// let schedulerStarted = false;

// // start scheduler automatically if a token is already stored
// if (getToken()) {
//   startScheduler(getToken);
//   schedulerStarted = true;
// }

// // ─────────────────────────────────────────────────────────────────────────────
// // Token onboarding
// // ─────────────────────────────────────────────────────────────────────────────

// // Exchange a one-time onboarding code for a bearer token
// app.post('/api/exchange', async (req, res) => {
//   const { code } = req.body;
//   if (!code) return res.status(400).json({ error: 'Missing code' });

//   try {
//     const r = await fetch('https://simcluster.ai/api/agent/session/exchange-code', {
//       method: 'POST',
//       headers: { 'Content-Type': 'application/json' },
//       body: JSON.stringify({ code }),
//     });

//     const data = await r.json();
//     const token = data?.bearerToken || data?.token;

//     if (!token) {
//       console.error('EXCHANGE RESPONSE (no token):', data);
//       return res.status(500).json({ error: 'No token returned', full: data });
//     }

//     saveToken(token);

//     if (!schedulerStarted) {
//       startScheduler(getToken);
//       schedulerStarted = true;
//     }

//     res.json({ success: true });
//   } catch (err) {
//     res.status(500).json({ error: err.message });
//   }
// });

// // Direct token save (for users who already have a bearer token)
// app.post('/api/save-token', (req, res) => {
//   const { token } = req.body;
//   if (!token) return res.status(400).json({ error: 'No token provided' });

//   saveToken(token);

//   if (!schedulerStarted) {
//     startScheduler(getToken);
//     schedulerStarted = true;
//   }

//   res.json({ success: true });
// });

// // ─────────────────────────────────────────────────────────────────────────────

// // ─────────────────────────────────────────────────────────────────────────────
// // Status check
// // ─────────────────────────────────────────────────────────────────────────────

// app.get('/status', (req, res) => {
//   res.json({ hasToken: !!getToken() });
// });

// // ─────────────────────────────────────────────────────────────────────────────

// app.listen(process.env.PORT || 3000, () => {
//   console.log('Server running on port', process.env.PORT || 3000);
// });
