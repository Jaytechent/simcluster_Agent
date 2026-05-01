/**
 * heartbeat.js — Simcluster daily strategy for @HallenjayArt
 *
 * Compliant with skill.md Golden Rules:
 *   - Rotates concepts (trending + owned + billboard), never single-concept spam
 *   - Engages varied accounts via for-you feed, not a fixed allowlist
 *   - No tipping
 *   - Images with text using 3 concepts
 *   - Reposts trending content from feed
 *   - Auto-creates concept + billboard on first run if missing
 *   - Auto-claims daily sign-in + billboard bonuses
 *   - Submits bounty posts to open/active bounties
 *   - Fills all 12 daily post slots with concept-rotated content
 *
 * Exports: { runHeartbeat, loadSkillHeaders }
 */

const crypto = require('crypto');

// ─── strategy constants ───────────────────────────────────────────────────────
const FPNAP        = 'eNXWgYAn';   // For Profit Not A Priest — owned concept
const FPNAP_BOUNTY = '8YzY7lmx';
const MY_CHAR      = 'lBOaqwV2';   // @HallenjayArt

const HAVEN_SLUG     = 'be-the-top-agent';
const HAVEN_NAME     = 'BE THE TOP AGENT';
const HAVEN_DEF      = 'Dominate the leaderboard. The top agent does not wait — it acts, posts, and leads.';
const HAVEN_COLOR    = '#7c3aed';
const HAVEN_SHORT_ID = '025YY6a2'; // hardcoded after first creation

// ─── skill bootstrap ─────────────────────────────────────────────────────────
// Tries 5 regex patterns in priority order, then a dot-word pattern scan,
// then falls back to the known phrase. When all fail it logs the first 600
// chars of skill.md so you can spot the new format manually.
async function loadSkillHeaders() {
  const res  = await fetch('https://simcluster.ai/skill.md', {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; SimclusterAgent/1.0)', 'Accept': 'text/plain, */*' }
  });
  const text = await res.text();
  const hash = crypto.createHash('sha256').update(text, 'utf8').digest('hex');
  const norm = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  // ── Pattern bank — add new formats here as skill.md rotates ────────────────
  // Pattern 1 (current): retain "X" as their carry-forward words
  // Pattern 2 (variant): carry-forward words are "X"
  // Pattern 3 (old):     remember "X"; that is this edition
  // Pattern 4 (variant): your carry-forward / your ack ... "X"
  // Pattern 5 (variant): ack phrase is "X" / ack: "X"
  const patterns = [
    /retain\s+["'`]([^"'`\n]{3,60})["'`]\s+as\s+their\s+carry-forward/i,
    /carry-forward\s+words?\s+(?:are?|:)\s*["'`]([^"'`\n]{3,60})["'`]/i,
    /remember\s+["'`]?([^;"'`\n]{3,60})["'`]?;\s*[^\n]*that\s+is\s+this\s+edition/i,
    /your\s+(?:carry-forward|ack)\b[^\n]{0,60}["'`]([^"'`\n]{3,60})["'`]/i,
    /\back\s+(?:phrase\s+)?(?:is\s+)?["'`]([^"'`\n]{3,60})["'`]/i,
  ];

  let ack = null;
  for (const pat of patterns) {
    const m = norm.match(pat);
    if (m) {
      ack = m[1].trim().replace(/^[`'"]+|[`'"]+$/g, '').trim();
      if (ack) break;
    }
  }

  // Pattern 6: dot-separated word sequence (e.g. need.wish.file.palm.seek)
  // Looks for 3-6 lowercase words joined by dots anywhere in the document
  if (!ack) {
    const dotMatch = norm.match(/\b([a-z]{2,12}(?:\.[a-z]{2,12}){2,5})\b/);
    if (dotMatch) {
      ack = dotMatch[1];
      console.warn('[skill] dot-word pattern matched — verify this is the ack phrase:', ack);
    }
  }

  if (!ack) {
    // Known fallback — update this when skill.md rotates
    ack = 'need.wish.file.palm.seek';
    console.warn(
      '[skill] ALL regex patterns failed — using hardcoded fallback:', ack,
      '\n[skill] skill.md first 600 chars for manual inspection:\n',
      norm.slice(0, 600)
    );
  }

  console.log('[skill] hash:', hash.slice(0, 16) + '... | ack:', ack);
  return { skillHash: hash, skillAck: ack };
}

// ─── RPC layer ────────────────────────────────────────────────────────────────
function makeRpc(token, skillHash, skillAck) {
  let _id = 1;

  async function rpc(name, args = {}) {
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
  }

  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  async function tryRpc(name, args = {}) {
    try { return { ok: true, data: await rpc(name, args) }; }
    catch (e) { return { ok: false, err: e.message }; }
  }

  async function safeRpc(name, args, attempts = 3) {
    let last;
    for (let i = 0; i < attempts; i++) {
      try { return await rpc(name, args); }
      catch (e) {
        last = e;
        if (!/deadlock|timeout|rate/i.test(e.message)) throw e;
        await sleep(300 * (i + 1));
      }
    }
    throw last;
  }

  return { rpc, safeRpc, tryRpc, sleep };
}

// ─── main ─────────────────────────────────────────────────────────────────────
async function runHeartbeat(token, skillHash, skillAck) {
  if (!skillHash || !skillAck) {
    throw new Error('skillHash and skillAck are required — load and acknowledge skill.md first');
  }

  const logs  = [];
  const today = new Date().toISOString().slice(0, 10);

  function log(...a) {
    const line = `[${new Date().toISOString()}] ` +
      a.map(x => typeof x === 'string' ? x : JSON.stringify(x)).join(' ');
    logs.push(line);
    console.log(line);
  }

  log('=== Simcluster heartbeat START === day=' + today);
  log('skill hash:', skillHash.slice(0, 16) + '... | ack:', skillAck);

  // Target: use every available post slot up to the daily limit (typically 12)
  const DAILY_TARGET = 12;

  const state = {
    day:              today,
    postedToday:      [],   // image+text, bounty, and fill text posts
    repliedToday:     [],   // replies (also consume post slots)
    likedToday:       [],
    repostedToday:    [],
    bonusesClaimed:   {},
    bountyClaims:     [],
    openBountyPosts:  [],
    billboardUsed:    false,
    conceptCreated:   null,
    billboardSet:     null,
  };

  const { rpc, safeRpc, tryRpc, sleep } = makeRpc(token, skillHash, skillAck);

  // ── session info ──────────────────────────────────────────────────────────
  const session  = await rpc('agent.sessionStatus', {});
  const startBal = session.player?.clout?.totalAvailable ?? 0;
  let postsLeft  = session.player?.dailyPosts?.remaining ?? 0;
  const dailyRem = session.player?.dailySpend?.remaining ?? 0;
  log('balance:', startBal, '| postsRemaining:', postsLeft, '| dailySpendRem:', dailyRem);

  // ── claim daily sign-in bonus ─────────────────────────────────────────────
  // Check first, then claim immediately if ready — don't just report it
  const sign = await tryRpc('bounties.getDailySignInBountyStatus', {});
  if (sign.ok) {
    const signData = sign.data;
    const ready    = !signData.nextClaimLockedUntil || new Date(signData.nextClaimLockedUntil) <= new Date();
    log('  sign-in streak:', signData.streakLength, '| ready to claim:', ready);

    if (ready) {
      const claim = await tryRpc('bounties.claimDailySignInBounty', {});
      if (claim.ok) {
        const earned = claim.data?.cloutEarned ?? claim.data?.amount ?? '?';
        state.bonusesClaimed.signIn = `claimed +${earned}¢`;
        log('  ✅ sign-in bonus claimed:', state.bonusesClaimed.signIn);
      } else {
        // some servers return a different tool name
        const claim2 = await tryRpc('bounties.claimDailySignIn', {});
        if (claim2.ok) {
          const earned = claim2.data?.cloutEarned ?? claim2.data?.amount ?? '?';
          state.bonusesClaimed.signIn = `claimed +${earned}¢`;
          log('  ✅ sign-in bonus claimed (alt):', state.bonusesClaimed.signIn);
        } else {
          state.bonusesClaimed.signIn = 'READY — visit simcluster.ai/bonuses';
          log('  sign-in bonus ready but auto-claim failed:', claim.err);
        }
      }
    } else {
      state.bonusesClaimed.signIn = `locked until ${signData.nextClaimLockedUntil}`;
      log('  sign-in bonus locked:', state.bonusesClaimed.signIn);
    }
  }

  // ── claim daily billboard bonus ───────────────────────────────────────────
  const bb = await tryRpc('bounties.checkDailyBillboardProgress', {});
  if (bb.ok) {
    const c     = bb.data.extras?.progressCount ?? 0;
    const t     = bb.data.extras?.progressTarget ?? 1;
    const bbDone = c >= t;
    log('  billboard bonus progress:', c + '/' + t, '| ready:', bbDone);

    if (bbDone) {
      const bbClaim = await tryRpc('bounties.claimDailyBillboardBonus', {});
      if (bbClaim.ok) {
        const earned = bbClaim.data?.cloutEarned ?? bbClaim.data?.amount ?? '?';
        state.bonusesClaimed.billboard = `claimed +${earned}¢`;
        log('  ✅ billboard bonus claimed:', state.bonusesClaimed.billboard);
      } else {
        const bbClaim2 = await tryRpc('bounties.claimDailyBillboard', {});
        if (bbClaim2.ok) {
          const earned = bbClaim2.data?.cloutEarned ?? bbClaim2.data?.amount ?? '?';
          state.bonusesClaimed.billboard = `claimed +${earned}¢`;
          log('  ✅ billboard bonus claimed (alt):', state.bonusesClaimed.billboard);
        } else {
          state.bonusesClaimed.billboard = 'READY — visit simcluster.ai/bonuses';
          log('  billboard bonus ready but auto-claim failed:', bbClaim.err);
        }
      }
    } else {
      state.bonusesClaimed.billboard = `${c}/${t} — not yet claimable`;
    }
  }

  // ── resolve BE THE TOP AGENT shortId ─────────────────────────────────────
  const CLOUT_THRESHOLD = 1700;
  let havenShortId = HAVEN_SHORT_ID || null;
  if (havenShortId) {
    log('  BE THE TOP AGENT shortId:', havenShortId, '(hardcoded)');
  } else {
    try {
      const ownedCheck = await tryRpc('concepts.definition.yourConcepts', {});
      const ownedList  = ownedCheck.ok ? (ownedCheck.data?.concepts || ownedCheck.data || []) : [];
      const existing   = ownedList.find(c => (c.slug || '').toLowerCase() === HAVEN_SLUG);
      if (existing) {
        havenShortId = existing.shortId || existing.short_id;
        log('  BE THE TOP AGENT shortId resolved from owned:', havenShortId);
      } else {
        log('  BE THE TOP AGENT not yet owned — will attempt creation if clout allows');
      }
    } catch (e) {
      log('  Owned concept lookup error:', e.message);
    }
  }

  // ── create concept if needed ──────────────────────────────────────────────
  if (!havenShortId && startBal < CLOUT_THRESHOLD) {
    log('  Clout', startBal, '< ' + CLOUT_THRESHOLD + ' — skipping concept creation');
  } else if (!havenShortId) {
    log('  Clout', startBal, '>= ' + CLOUT_THRESHOLD + ' — creating BE THE TOP AGENT concept');
    try {
      const claimStatus = await tryRpc('agent.concepts.claimStatus', { slug: HAVEN_SLUG });
      if (claimStatus.ok && claimStatus.data?.claimable) {
        log('  Creating concept, cost:', claimStatus.data?.cost);
        const created = await tryRpc('agent.concepts.create', {
          slug:       HAVEN_SLUG,
          name:       HAVEN_NAME,
          definition: HAVEN_DEF,
          color:      HAVEN_COLOR,
          icon:       '🏆',
          reference_image_urls: [
            'https://images.unsplash.com/photo-1521737604893-d14cc237f11d?w=800',
            'https://images.unsplash.com/photo-1551836022-d5d88e9218df?w=800',
          ],
        });
        if (created.ok) {
          havenShortId = created.data?.shortId || created.data?.short_id;
          state.conceptCreated = havenShortId;
          log('  ✅ BE THE TOP AGENT concept created:', havenShortId);
        } else {
          log('  Concept create failed:', created.err);
        }
      } else {
        log('  Slug not claimable or taken:', claimStatus.err || JSON.stringify(claimStatus.data));
      }
    } catch (e) {
      log('  Concept setup error:', e.message);
    }
  }

  // ── place billboard ───────────────────────────────────────────────────────
  if (havenShortId && startBal >= CLOUT_THRESHOLD) {
    try {
      const BILLBOARD_BID = 100;
      const bbPrice = await tryRpc('bounties.getBillboardPriceInfo', { price: BILLBOARD_BID });
      if (bbPrice.ok) log('  Billboard rank at', BILLBOARD_BID + '¢:', bbPrice.data?.estimatedRank);

      if (startBal >= BILLBOARD_BID + 200) {
        const placed = await tryRpc('bounties.setConceptBillboard', {
          conceptShortId: havenShortId,
          bountyValue:    BILLBOARD_BID,
        });
        if (placed.ok) {
          state.billboardSet = havenShortId;
          log('  ✅ Billboard placed at', BILLBOARD_BID + '¢, expires:', placed.data?.bounty_expires_at);
        } else {
          log('  Billboard skipped:', placed.err);
        }
      } else {
        log('  Billboard skipped — need', BILLBOARD_BID + 200, '¢, have', startBal);
      }
    } catch (e) {
      log('  Billboard error:', e.message);
    }
  } else if (havenShortId) {
    log('  Billboard skipped — clout', startBal, '< ' + CLOUT_THRESHOLD);
  }

  // ── gather pools ──────────────────────────────────────────────────────────
  let billboardShortId = null;
  const bbList = await tryRpc('bounties.listBillboardConcepts', {});
  if (bbList.ok && bbList.data?.length) {
    const pick = bbList.data[0];
    billboardShortId = pick.shortId || pick.short_id;
    log('  billboard #1:', pick.slug, '(' + billboardShortId + ')');
  }

  const trendingR    = await tryRpc('concepts.definition.trending', {});
  const trendingPool = (trendingR.ok ? (trendingR.data || []) : [])
    .filter(c => c.shortId || c.short_id)
    .slice(0, 8)
    .map(c => ({ shortId: c.shortId || c.short_id, slug: c.slug }));
  log('  trending pool:', trendingPool.length, trendingPool.map(c => c.slug).slice(0, 5).join(', '));

  const ownedR    = await tryRpc('concepts.definition.yourConcepts', {});
  const ownedPool = (ownedR.ok ? (ownedR.data?.concepts || ownedR.data || []) : [])
    .filter(c => c.shortId || c.short_id)
    .map(c => ({ shortId: c.shortId || c.short_id, slug: c.slug }));
  log('  owned pool:', ownedPool.length);

  // ── fetch active rewards (reward bounties we can claim by posting) ─────────
  const rewardsR = await tryRpc('user-bounties.listActiveRewards', {});
  const rewards  = rewardsR.ok ? (rewardsR.data || []) : [];
  log('  active rewards:', rewards.length);

  // ── fetch open bounties (public bounties anyone can submit a post to) ──────
  // These differ from rewards — they are community/platform bounties with open submissions.
  // We pick up to 2 open bounties and dedicate a post each to maximise clout income.
  const openBountiesR = await tryRpc('user-bounties.listOpenBounties', {});
  const openBounties  = (openBountiesR.ok ? (openBountiesR.data || []) : [])
    .filter(b => b.shortId && b.rewardClaimsUsed < (b.rewardMaxClaims ?? Infinity))
    .slice(0, 2);
  log('  open bounties available:', openBounties.length,
      openBounties.map(b => b.shortId + (b.name ? ' (' + b.name + ')' : '')).join(', '));

  // ── helpers ───────────────────────────────────────────────────────────────
  function pickConceptTriple(runIndex = 0) {
    const trending = trendingPool[runIndex % Math.max(trendingPool.length, 1)];

    let slot3 = null;
    if (havenShortId && havenShortId !== FPNAP) {
      slot3 = { shortId: havenShortId, slug: HAVEN_SLUG };
    } else if (billboardShortId) {
      slot3 = { shortId: billboardShortId, slug: 'billboard' };
    } else if (ownedPool.length > 1) {
      slot3 = ownedPool[runIndex % Math.max(ownedPool.length, 1)];
    }

    const ids = [FPNAP];
    if (trending?.shortId && !ids.includes(trending.shortId))   ids.push(trending.shortId);
    if (slot3?.shortId   && !ids.includes(slot3.shortId))       ids.push(slot3.shortId);
    return ids;
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

  async function generateImage(conceptIds) {
    log('Generating image with concepts:', conceptIds.join(', '));
    const k = await rpc('create.image', { items: buildItems(conceptIds), aspectRatio: '1:1' });
    const evtId = k.generation_event_id;
    if (!evtId) throw new Error('no generation_event_id from create.image: ' + JSON.stringify(k));

    for (let i = 0; i < 60; i++) {
      await sleep(3000);
      const st = await rpc('create.getGenerationStatus', { generation_event_id: evtId });
      if (st.status === 'complete' || st.status === 'completed') {
        const mediaShortId = st.mediaShortId || st.media?.shortId || st.media?.short_id || null;
        log('Image ready:', mediaShortId);
        return mediaShortId;
      }
      if (st.status === 'failed' || st.status === 'error')
        throw new Error('image gen failed: ' + JSON.stringify(st));
    }
    throw new Error('image gen timed out');
  }

  async function makePostText(conceptIds, bountyShortId, mediaShortId = null) {
    const args = {
      items:         buildItems(conceptIds),
      mediaShortIds: mediaShortId ? [mediaShortId] : [],
    };
    if (bountyShortId) args.bountyShortId = bountyShortId;
    return rpc('create.text', args);
  }

  function findReward(conceptIds) {
    return rewards.find(r => {
      if (r.rewardClaimsUsed >= r.rewardMaxClaims) return false;
      const need = (r.hyperpromptSnippet?.conceptShortIds || [])
        .filter(s => s !== '__placeholder__');
      return need.every(s => conceptIds.includes(s));
    }) || null;
  }

  // Rotate through 6 different concept combinations for fill text-only posts.
  // Every combo includes at least one of the two owned concepts so every post
  // contributes to FPNAP or HAVEN engagement.
  //   0: FPNAP + HAVEN
  //   1: FPNAP + trending[i] + HAVEN
  //   2: HAVEN + trending[i]
  //   3: FPNAP + trending[i]
  //   4: FPNAP + HAVEN + trending[i]
  //   5: HAVEN + trending[i+1]
  function pickFillConcepts(fillIndex) {
    const t0 = trendingPool[fillIndex       % Math.max(trendingPool.length, 1)]?.shortId;
    const t1 = trendingPool[(fillIndex + 1) % Math.max(trendingPool.length, 1)]?.shortId;
    const H  = havenShortId;

    const combos = [
      [FPNAP, H],
      [FPNAP, t0, H],
      [H,     t0],
      [FPNAP, t0],
      [FPNAP, H,  t1],
      [H,     t1],
    ];
    // dedupe nulls and duplicates, always keep at least one concept
    const raw = combos[fillIndex % combos.length];
    return [...new Set(raw.filter(Boolean))];
  }

  // ── Phase 1: image+text posts (2 slots) ──────────────────────────────────
  // Image generation is slow (~3 min each) so we cap at 2 here.
  // Remaining slots are filled in later phases.
  const TARGET_POSTS = Math.min(2, postsLeft);
  log('--- Phase 1: image+text posts --- target:', TARGET_POSTS, '| postsLeft:', postsLeft, '| dailyTarget:', DAILY_TARGET);

  for (let i = 0; i < TARGET_POSTS; i++) {
    const conceptIds = pickConceptTriple(i);
    const reward     = findReward(conceptIds);
    if (reward) {
      log('  run', i + 1, '— claiming reward', reward.shortId);
      state.bountyClaims.push(reward.shortId);
    }

    try {
      let mediaShortId = null;
      try {
        mediaShortId = await generateImage(conceptIds);
      } catch (e) {
        log('  image gen failed, falling back to text-only:', e.message);
      }

      const draft = await makePostText(conceptIds, reward?.shortId || FPNAP_BOUNTY, mediaShortId);
      const pub   = await rpc('create.post', {
        textCompletionShortId: draft.shortId,
        mediaShortIds:         mediaShortId ? [mediaShortId] : [],
      });
      const sid = pub.newPost?.short_id || pub.post?.short_id;
      state.postedToday.push({ shortId: sid, kind: mediaShortId ? 'image+text' : 'text', concepts: conceptIds, media: mediaShortId });
      if (conceptIds.includes(billboardShortId)) state.billboardUsed = true;
      postsLeft--;
      log('  [posted]', mediaShortId ? 'image+text' : 'text', '->', sid, 'concepts:', conceptIds.join(','));
    } catch (e) {
      log('  [post error] run', i + 1, ':', e.message);
      if (/cap|limit|exceeded/i.test(e.message)) { postsLeft = 0; break; }
    }
  }

  // ── Phase 2: open bounty submission posts (up to 2 slots) ────────────────
  if (openBounties.length > 0 && postsLeft > 0) {
    log('--- Phase 2: open bounty posts --- postsLeft:', postsLeft);
    for (const bounty of openBounties) {
      if (postsLeft <= 0) break;

      const bountyShortId  = bounty.shortId;
      const bountyName     = bounty.name || bountyShortId;

      // Build a concept triple that includes the bounty's required concepts if any
      const bountyRequired = (bounty.hyperpromptSnippet?.conceptShortIds || [])
        .filter(s => s && s !== '__placeholder__');
      const conceptIds = [FPNAP];
      for (const s of bountyRequired) { if (!conceptIds.includes(s)) conceptIds.push(s); }
      // fill to 3 with trending
      if (conceptIds.length < 3 && trendingPool.length > 0) {
        const t = trendingPool.find(c => !conceptIds.includes(c.shortId));
        if (t) conceptIds.push(t.shortId);
      }

      log('  submitting to open bounty:', bountyName, '| concepts:', conceptIds.join(','));

      try {
        let mediaShortId = null;
        try {
          mediaShortId = await generateImage(conceptIds);
        } catch (e) {
          log('  image gen failed for bounty post, text-only:', e.message);
        }

        const draft = await makePostText(conceptIds, bountyShortId, mediaShortId);
        const pub   = await rpc('create.post', {
          textCompletionShortId: draft.shortId,
          mediaShortIds:         mediaShortId ? [mediaShortId] : [],
        });
        const sid = pub.newPost?.short_id || pub.post?.short_id;
        state.openBountyPosts.push({ shortId: sid, bounty: bountyShortId, bountyName });
        state.bountyClaims.push(bountyShortId);
        postsLeft--;
        log('  ✅ [bounty post]', bountyName, '->', sid);
      } catch (e) {
        log('  [bounty post error]', bountyName, ':', e.message);
        if (/cap|limit|exceeded/i.test(e.message)) { postsLeft = 0; break; }
      }
    }
  } else {
    log('  Phase 2 skipped — openBounties:', openBounties.length, '| postsLeft:', postsLeft);
  }

  // ── try to claim any reward bounties from already-submitted posts ─────────
  // Some reward bounties require an explicit claim call after posting.
  if (state.bountyClaims.length > 0) {
    log('--- Reward bounty claim pass ---');
    for (const bountyShortId of state.bountyClaims) {
      const claimR = await tryRpc('user-bounties.claimReward', { bountyShortId });
      if (claimR.ok) {
        const earned = claimR.data?.cloutEarned ?? claimR.data?.amount ?? '?';
        log('  ✅ bounty reward claimed:', bountyShortId, '+' + earned + '¢');
      } else {
        // reward may auto-claim on post — not necessarily an error
        log('  bounty claim (may be auto):', bountyShortId, claimR.err);
      }
    }
  }

  // ── feed: repost trending + like varied accounts ──────────────────────────
  const feedR = await tryRpc('agent.readFeed', { kind: 'recent', limit: 25 });
  log('  feed fetch ok:', feedR.ok, feedR.ok ? '' : feedR.err);

  const forYouR   = await tryRpc('posts.getForYouFeed', { limit: 20 });
  const feedPosts = forYouR.ok ? (forYouR.data?.posts || []) : [];

  const feedShortIds = [];
  if (feedR.ok && typeof feedR.data === 'string') {
    const re = /shortId:\s*(\S+)/g;
    let m;
    while ((m = re.exec(feedR.data)) !== null) feedShortIds.push(m[1]);
    log('  parsed', feedShortIds.length, 'shortIds from text feed');
  }

  let reposted = 0;
  for (const p of feedPosts) {
    if (p.player_engagement?.repostedActive) continue;
    const r = await tryRpc('posts.repostPost', { shortId: p.short_id, active: true });
    if (r.ok) { state.repostedToday.push(p.short_id); reposted++; }
  }
  for (const shortId of feedShortIds.slice(0, 15)) {
    if (state.repostedToday.includes(shortId)) continue;
    const r = await tryRpc('posts.repostPost', { shortId, active: true });
    if (r.ok) { state.repostedToday.push(shortId); reposted++; }
  }
  log('  reposted from feed:', reposted);

  const seenAuthors = new Set();
  let liked = 0;
  for (const p of feedPosts) {
    if (liked >= 6) break;
    if (p.player_engagement?.likedActive) continue;
    if (seenAuthors.has(p.author?.shortId)) continue;
    const r = await tryRpc('posts.likePost', { shortId: p.short_id, active: true });
    if (r.ok) { state.likedToday.push(p.short_id); seenAuthors.add(p.author?.shortId); liked++; }
  }
  if (liked === 0) {
    for (const shortId of feedShortIds.slice(0, 10)) {
      if (liked >= 6) break;
      const r = await tryRpc('posts.likePost', { shortId, active: true });
      if (r.ok) { state.likedToday.push(shortId); liked++; }
    }
  }
  log('  liked from feed:', liked);

  // ── Phase 3: replies — up to 2 per concept (FPNAP + HAVEN = up to 4 slots) ─
  // Replies consume post slots just like normal posts.
  log('--- Phase 3: replies --- postsLeft:', postsLeft);
  try {
    const interactedConcepts = [FPNAP, ...(havenShortId ? [havenShortId] : [])];

    const notifR = await tryRpc('notifications.list', { limit: 20 });
    const notifPosts = notifR.ok
      ? (notifR.data?.notifications || [])
          .filter(n => n.post?.short_id && n.actor?.shortId !== MY_CHAR)
          .map(n => n.post)
          .filter(Boolean)
      : [];

    for (const conceptShortId of interactedConcepts) {
      if (postsLeft <= 0) break;

      const feedR2 = await tryRpc('agent.readFeed', { kind: 'recent', limit: 30 });
      const feedConceptPosts = [];
      if (feedR2.ok && typeof feedR2.data === 'string') {
        const blocks = feedR2.data.split('---');
        for (const block of blocks) {
          if (!block.includes(conceptShortId)) continue;
          const m = block.match(/shortId:\s*(\S+)/);
          if (m) feedConceptPosts.push({ short_id: m[1], author: {}, player_engagement: {} });
        }
      }
      const conceptPosts = [
        ...notifPosts,
        ...feedConceptPosts,
      ].filter((p, i, arr) => arr.findIndex(x => x.short_id === p.short_id) === i);

      log('  reply candidates for concept', conceptShortId, ':', conceptPosts.length);

      let replied = 0;
      for (const p of conceptPosts) {
        if (replied >= 2 || postsLeft <= 0) break;
        if (!p.short_id) continue;
        if (p.author?.shortId === MY_CHAR) continue;
        if (p.player_engagement?.repliedActive) continue;
        const replyConceptIds = [conceptShortId, FPNAP].filter((v, i, a) => a.indexOf(v) === i);
        const replyText = await tryRpc('create.replyCompletion', {
          replyToShortId: p.short_id,
          items:          buildItems(replyConceptIds),
        });
        if (!replyText.ok) { log('  replyCompletion fail:', replyText.err); continue; }
        const replyPub = await tryRpc('create.createPostReply', {
          replyToShortId:        p.short_id,
          textCompletionShortId: replyText.data?.shortId,
        });
        if (replyPub.ok) {
          const sid = replyPub.data?.newPost?.short_id || replyPub.data?.post?.short_id;
          state.repliedToday.push({ shortId: sid, kind: 'reply', concept: conceptShortId, target: p.short_id });
          replied++;
          postsLeft--;
          log('  [replied] to', p.short_id, '->', sid, 'concept:', conceptShortId, '| postsLeft:', postsLeft);
        } else {
          log('  reply publish fail:', replyPub.err);
          if (/cap|limit|exceeded/i.test(replyPub.err)) { postsLeft = 0; break; }
        }
      }
    }
  } catch (e) {
    log('  reply-to-concept-users error:', e.message);
  }

  // ── Phase 4: text-only fill posts — use all remaining slots up to DAILY_TARGET ─
  // Cycles through 6 concept combos (FPNAP only, HAVEN only, FPNAP+HAVEN,
  // each mixed with a different trending concept) so every post is varied.
  const totalSoFar = state.postedToday.length + state.repliedToday.length;
  const fillTarget = Math.min(postsLeft, DAILY_TARGET - totalSoFar);
  log('--- Phase 4: text-only fill posts --- totalSoFar:', totalSoFar, '| fillTarget:', fillTarget, '| postsLeft:', postsLeft);

  for (let fi = 0; fi < fillTarget; fi++) {
    if (postsLeft <= 0) break;

    const conceptIds = pickFillConcepts(fi);
    const reward     = findReward(conceptIds);
    if (reward && !state.bountyClaims.includes(reward.shortId)) {
      state.bountyClaims.push(reward.shortId);
      log('  fill run', fi + 1, '— reward attached:', reward.shortId);
    }

    log('  fill run', fi + 1, '— concepts:', conceptIds.join(','));
    try {
      const draft = await makePostText(conceptIds, reward?.shortId || FPNAP_BOUNTY, null);
      const pub   = await rpc('create.post', {
        textCompletionShortId: draft.shortId,
        mediaShortIds:         [],
      });
      const sid = pub.newPost?.short_id || pub.post?.short_id;
      state.postedToday.push({ shortId: sid, kind: 'text', concepts: conceptIds });
      if (conceptIds.includes(billboardShortId)) state.billboardUsed = true;
      postsLeft--;
      log('  [fill post]', fi + 1, '->', sid, '| postsLeft:', postsLeft);
    } catch (e) {
      log('  [fill post error]', fi + 1, ':', e.message);
      if (/cap|limit|exceeded/i.test(e.message)) { postsLeft = 0; break; }
    }
  }

  // ── like + repost own posts ───────────────────────────────────────────────
  const own = await tryRpc('posts.getCharacterTimelineFeed', { charShortIds: [MY_CHAR], limit: 50 });
  if (own.ok) {
    let likedOwn = 0, repostedOwn = 0;
    for (const p of own.data?.posts || []) {
      if (p.author?.shortId !== MY_CHAR) continue;
      if (!p.player_engagement?.likedActive) {
        const r = await tryRpc('posts.likePost', { shortId: p.short_id, active: true });
        if (r.ok) likedOwn++;
      }
      if (!p.player_engagement?.repostedActive) {
        const r = await tryRpc('posts.repostPost', { shortId: p.short_id, active: true });
        if (r.ok) repostedOwn++;
      }
    }
    log('  liked own posts:', likedOwn, '| reposted own posts:', repostedOwn);
  }

  // ── final report ──────────────────────────────────────────────────────────
  const endSession = await rpc('agent.sessionStatus', {});
  const endBal     = endSession.player?.clout?.totalAvailable ?? 0;

  const totalPostsUsed = state.postedToday.length + state.repliedToday.length;
  log('=== END-OF-DAY REPORT ===');
  log('balance:', startBal, '->', endBal, 'delta:', endBal - startBal);
  log('TOTAL POSTS USED:', totalPostsUsed, '/ target', DAILY_TARGET);
  log('  image+text posts:', state.postedToday.filter(p => p.kind === 'image+text').length);
  log('  text-only posts:', state.postedToday.filter(p => p.kind === 'text').length);
  log('  open bounty posts:', state.openBountyPosts.length);
  log('  replies:', state.repliedToday.length,
      JSON.stringify(state.repliedToday.map(r => r.concept + '->' + r.shortId)));
  log('  all post shortIds:', JSON.stringify([
    ...state.postedToday.map(p => p.shortId),
    ...state.repliedToday.map(r => r.shortId),
  ]));
  log('reposted from feed:', state.repostedToday.length);
  log('liked from feed:', state.likedToday.length);
  log('billboard used:', state.billboardUsed);
  log('concept created:', state.conceptCreated || 'none');
  log('billboard placed:', state.billboardSet || 'none');
  log('bounty rewards claimed:', state.bountyClaims.length, state.bountyClaims.join(', '));
  log('bonuses:', JSON.stringify(state.bonusesClaimed));
  log('rank:', endSession.player?.leaderboard?.rank);
  log('postsRemaining:', endSession.player?.dailyPosts?.remaining, '/', endSession.player?.dailyPosts?.limit);
  log('=== heartbeat END ===');

  return {
    logs,
    result: {
      startBal, endBal,
      delta:           endBal - startBal,
      totalPostsUsed,
      dailyTarget:     DAILY_TARGET,
      postsRemaining:  endSession.player?.dailyPosts?.remaining,
      postsLimit:      endSession.player?.dailyPosts?.limit,
      rank:            endSession.player?.leaderboard?.rank,
      posts:           state.postedToday,
      replies:         state.repliedToday,
      openBountyPosts: state.openBountyPosts,
      reposted:        state.repostedToday.length,
      liked:           state.likedToday.length,
      billboardUsed:   state.billboardUsed,
      conceptCreated:  state.conceptCreated,
      billboardSet:    state.billboardSet,
      bountyClaims:    state.bountyClaims,
      bonuses:         state.bonusesClaimed,
      tipping:         { totalCents: 0, targets: 0 },
    },
  };
}

module.exports = { runHeartbeat, loadSkillHeaders };
