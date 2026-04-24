require("dotenv").config();

const express = require('express');
const { saveToken, getToken } = require('./tokenStore');
const startScheduler = require('./scheduler');
const { runHeartbeat } = require('./heartbeat');

const app = express();
app.use(express.json());
app.use(express.static('public'));

let schedulerStarted = false;

// start scheduler automatically if a token is already stored
if (getToken()) {
  startScheduler(getToken);
  schedulerStarted = true;
}

// ─────────────────────────────────────────────────────────────────────────────
// Token onboarding
// ─────────────────────────────────────────────────────────────────────────────

// Exchange a one-time onboarding code for a bearer token
app.post('/api/exchange', async (req, res) => {
  const { code } = req.body;
  if (!code) return res.status(400).json({ error: 'Missing code' });

  try {
    const r = await fetch('https://simcluster.ai/api/agent/session/exchange-code', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
    });

    const data = await r.json();
    const token = data?.bearerToken || data?.token;

    if (!token) {
      console.error('EXCHANGE RESPONSE (no token):', data);
      return res.status(500).json({ error: 'No token returned', full: data });
    }

    saveToken(token);

    if (!schedulerStarted) {
      startScheduler(getToken);
      schedulerStarted = true;
    }

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Direct token save (for users who already have a bearer token)
app.post('/api/save-token', (req, res) => {
  const { token } = req.body;
  if (!token) return res.status(400).json({ error: 'No token provided' });

  saveToken(token);

  if (!schedulerStarted) {
    startScheduler(getToken);
    schedulerStarted = true;
  }

  res.json({ success: true });
});

// ─────────────────────────────────────────────────────────────────────────────
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

// ─────────────────────────────────────────────────────────────────────────────
// Status check
// ─────────────────────────────────────────────────────────────────────────────

app.get('/status', (req, res) => {
  res.json({ hasToken: !!getToken() });
});

// ─────────────────────────────────────────────────────────────────────────────

app.listen(process.env.PORT || 3000, () => {
  console.log('Server running on port', process.env.PORT || 3000);
});
// // #!/usr/bin/env node
// require("dotenv").config();

// const express = require('express');
// const { saveToken, getToken } = require('./tokenStore');
// const startScheduler = require('./scheduler');

// const app = express();
// app.use(express.json());
// app.use(express.static('public'));

// let schedulerStarted = false;

// // start scheduler if token already exists
// if (getToken()) {
//   startScheduler(getToken);
//   schedulerStarted = true;
// }

// // 🔑 onboarding route
// app.post('/api/exchange', async (req, res) => {
//   const { code } = req.body;

//   if (!code) {
//     return res.status(400).json({ error: 'Missing code' });
//   }

//   try {
//     const r = await fetch('https://simcluster.ai/api/agent/session/exchange-code', {
//       method: 'POST',
//       headers: { 'Content-Type': 'application/json' },
//       body: JSON.stringify({ code })
//     });

//     const data = await r.json();
//     const token = data?.bearerToken || data?.token;

//     if (!token) {
//     console.log('EXCHANGE RESPONSE:', data);

// if (!token) {
//   return res.status(500).json({
//     error: 'No token returned',
//     full: data
//   });
// }
//     }

//     saveToken(token);

//     // start scheduler only once
//     if (!schedulerStarted) {
//       startScheduler(getToken);
//       schedulerStarted = true;
//     }

//     res.json({ success: true });

//   } catch (err) {
//     res.status(500).json({ error: err.message });
//   }
// });

// app.get('/status', (req, res) => {
//   res.json({
//     hasToken: !!getToken()
//   });
// });


// app.post('/api/save-token', (req, res) => {
//   const { token } = req.body;

//   if (!token) {
//     return res.status(400).json({ error: 'No token provided' });
//   }

//   saveToken(token);

//   if (!schedulerStarted) {
//     startScheduler(getToken);
//     schedulerStarted = true;
//   }

//   res.json({ success: true });
// });
// app.listen(process.env.PORT || 3000, () => {
//   console.log('Server running...');
// });