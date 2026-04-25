// const { runHeartbeat } = require('./heartbeat');

// function startScheduler(getToken) {
//   console.log('Scheduler started...');

//   async function job() {
//     const token = getToken();

//     if (!token) {
//       console.log('No token yet, skipping...');
//       return;
//     }

//     try {
//       await runHeartbeat(token);
//     } catch (e) {
//       console.error('Heartbeat error:', e.message);
//     }
//   }

//   job(); // run immediately
//   setInterval(job, 24 * 60 * 60 * 1000);
// }

// // dummy (since you're using it)
// function activateSlot(slot) {
//   console.log('Slot activated:', slot);
// }

// module.exports = {
//   startScheduler,
//   activateSlot
// };
const { getToken }                    = require('./tokenStore');
const { runHeartbeat, loadSkillHeaders } = require('./heartbeat');
const { TOTAL_SLOTS }                 = require('./slotCodes');

const INTERVAL_MS = 24 * 60 * 60 * 1000;
const running     = new Set();

async function runSlot(slot) {
  const token = getToken(slot);
  if (!token) { console.log(`[scheduler] slot ${slot}: no token, skipping`); return; }

  console.log(`[scheduler] slot ${slot}: loading skill.md...`);
  let skillHash, skillAck;
  try {
    ({ skillHash, skillAck } = await loadSkillHeaders());
    console.log(`[scheduler] slot ${slot}: skill hash=${skillHash.slice(0,12)}... ack acquired`);
  } catch (e) {
    console.error(`[scheduler] slot ${slot}: skill load failed — ${e.message}`);
    return;
  }

  console.log(`[scheduler] slot ${slot}: starting heartbeat`);
  try {
    await runHeartbeat(token, skillHash, skillAck);
    console.log(`[scheduler] slot ${slot}: done`);
  } catch (e) {
    console.error(`[scheduler] slot ${slot} heartbeat error:`, e.message);
  }
}

function activateSlot(slot) {
  if (running.has(slot)) return;
  running.add(slot);
  console.log(`[scheduler] slot ${slot}: activated`);
  runSlot(slot);
  setInterval(() => runSlot(slot), INTERVAL_MS);
}

function startScheduler() {
  console.log(`[scheduler] booting — scanning ${TOTAL_SLOTS} slots`);
  for (let i = 1; i <= TOTAL_SLOTS; i++) {
    if (getToken(i)) activateSlot(i);
    else console.log(`[scheduler] slot ${i}: empty`);
  }
}

module.exports = { startScheduler, activateSlot };