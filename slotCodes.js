/**
 * slotCodes.js — maps opaque access codes to slot numbers (1–10)
 *
 * Set SLOT_CODES in your environment as a comma-separated list of 10 codes
 * in slot order. Example:
 *
 *   SLOT_CODES=wolf-7x2q,rain-3kpz,echo-9mva,dust-2rwx,iron-5bnq,lime-4cjs,neon-8ytf,jade-1xwm,bolt-6dhu,star-0pvr
 *
 * Code at index 0 → slot 1, index 1 → slot 2, etc.
 *
 * If SLOT_CODES is not set, falls back to plain "slot1".."slot10" (dev only).
 */

const TOTAL_SLOTS = 10;

function buildCodeMap() {
  const raw = process.env.SLOT_CODES || '';
  const codes = raw.split(',').map(s => s.trim()).filter(Boolean);

  const map = {}; // code -> slot number

  for (let i = 0; i < TOTAL_SLOTS; i++) {
    const code = codes[i] || `slot${i + 1}`; // fallback for dev
    map[code] = i + 1;
  }

  return map;
}

const CODE_MAP = buildCodeMap();

/**
 * Resolve an access code to a slot number (1–10).
 * Returns null if the code is invalid.
 */
function resolveSlot(accessCode) {
  return CODE_MAP[accessCode] ?? null;
}

/** All valid access codes (for admin reference) */
function allCodes() {
  return Object.entries(CODE_MAP).map(([code, slot]) => ({ code, slot }));
}

module.exports = { resolveSlot, allCodes, TOTAL_SLOTS };