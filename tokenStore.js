/**
 * tokenStore.js — slot-aware bearer token persistence
 *
 * Each slot maps to bearer{N}.txt in TOKEN_DIR (default: ./tokens/).
 * Pre-create these files (empty) before deployment so the directory exists.
 *
 * TOKEN_DIR can be pointed at a Render Disk mount path to survive restarts.
 */

const fs   = require('fs');
const path = require('path');

const TOKEN_DIR = process.env.TOKEN_DIR || path.join(__dirname, 'tokens');

function tokenPath(slot) {
  return path.join(TOKEN_DIR, `bearer${slot}.txt`);
}

function getToken(slot) {
  try {
    const t = fs.readFileSync(tokenPath(slot), 'utf8').trim();
    return t || null;
  } catch (_) { return null; }
}

function saveToken(slot, token) {
  fs.mkdirSync(TOKEN_DIR, { recursive: true });
  fs.writeFileSync(tokenPath(slot), token.trim(), 'utf8');
}

function clearToken(slot) {
  try { fs.writeFileSync(tokenPath(slot), '', 'utf8'); } catch (_) {}
}

// Return array of all slot numbers that have a token
function activeSlots(totalSlots = 10) {
  const slots = [];
  for (let i = 1; i <= totalSlots; i++) {
    if (getToken(i)) slots.push(i);
  }
  return slots;
}

module.exports = { getToken, saveToken, clearToken, activeSlots };


// const fs = require('fs');
// const path = require('path');

// const FILE = path.join(__dirname, 'storage', 'bearer.txt');

// function saveToken(token) {
//   fs.writeFileSync(FILE, token.trim());
// }

// function getToken() {
//   if (process.env.SIMCLUSTER_BEARER) {
//     return process.env.SIMCLUSTER_BEARER.trim();
//   }

//   if (fs.existsSync(FILE)) {
//     return fs.readFileSync(FILE, 'utf-8').trim();
//   }

//   return null;
// }

// module.exports = { saveToken, getToken };