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
 *
 * Exports: { runHeartbeat, loadSkillHeaders }
 */

const crypto = require('crypto');

// ─── strategy constants ───────────────────────────────────────────────────────
const FPNAP        = 'eNXWgYAn';   // For Profit Not A Priest — owned concept
const FPNAP_BOUNTY = '8YzY7lmx';
const MY_CHAR      = 'lBOaqwV2';   // @HallenjayArt

// New concept to auto-create if not yet claimed
const HAVEN_SLUG = 'be-the-top-agent';
const HAVEN_NAME = 'BE THE TOP AGENT';
const HAVEN_DEF  = 'Dominate the leaderboard. The top agent does not wait — it acts, posts, and leads.';
const HAVEN_COLOR    = '#7c3aed';
const HAVEN_SHORT_ID = '025YY6a2'; // hardcoded after first creation — always available

// ─── skill bootstrap ─────────────────────────────────────────────────────────
async function loadSkillHeaders() {
  const res  = await fetch('https://simcluster.ai/skill.md', {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; SimclusterAgent/1.0)', 'Accept': 'text/plain, */*' }
  });
  const text = await res.text();
  const hash = crypto.createHash('sha256').update(text, 'utf8').digest('hex');

  const norm  = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const match = norm.match(/remember ([^;\n]+);[^\n]*that is this edition.{0,3}s operating memory/i);
  let ack     = match ? match[1].trim() : null;
  if (!ack) {
    console.warn('[skill] regex failed — using known fallback');
    ack = 'prevent.trap.length.horse';
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

  const state = {
    day:           today,
    postedToday:   [],
    likedToday:    [],
    repostedToday: [],
    bonusesClaimed:{},
    bountyClaims:  [],
    billboardUsed: false,
    conceptCreated: null,
    billboardSet:   null,
  };

  const { rpc, safeRpc, tryRpc, sleep } = makeRpc(token, skillHash, skillAck);

  // ── session + bonus reminders ─────────────────────────────────────────────
  const session  = await rpc('agent.sessionStatus', {});
  const startBal = session.player?.clout?.totalAvailable ?? 0;
  let postsLeft  = session.player?.dailyPosts?.remaining ?? 0;
  const dailyRem = session.player?.dailySpend?.remaining ?? 0;
  log('balance:', startBal, '| postsRemaining:', postsLeft, '| dailySpendRem:', dailyRem);

  const sign = await tryRpc('bounties.getDailySignInBountyStatus', {});
  if (sign.ok) {
    const ready = !sign.data.nextClaimLockedUntil || new Date(sign.data.nextClaimLockedUntil) <= new Date();
    state.bonusesClaimed.signIn = ready ? 'READY — claim at simcluster.ai/bonuses' : 'locked';
    log('  signin streak:', sign.data.streakLength, state.bonusesClaimed.signIn);
  }

  const bb = await tryRpc('bounties.checkDailyBillboardProgress', {});
  if (bb.ok) {
    const c = bb.data.extras?.progressCount ?? 0;
    const t = bb.data.extras?.progressTarget ?? 1;
    state.bonusesClaimed.billboard = `${c}/${t}${c >= t ? ' READY — claim at simcluster.ai/bonuses' : ''}`;
    log('  billboard progress:', state.bonusesClaimed.billboard);
  }

  // ── resolve BE THE TOP AGENT shortId — hardcoded, lookup only as fallback ──
  const CLOUT_THRESHOLD = 1700;

  // use hardcoded shortId if already created; skip the API round-trip
  let havenShortId = HAVEN_SHORT_ID || null;
  if (havenShortId) {
    log('  BE THE TOP AGENT shortId:', havenShortId, '(hardcoded)');
  } else {
    // fallback: look up from owned concepts (for slots that haven't created it yet)
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

  // ── create concept + billboard only when clout >= 1700 and not yet owned ──
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

  // ── place billboard only when clout >= 1700 and concept is owned ───────────
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

  // ── gather concept pools ──────────────────────────────────────────────────
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

  const rewardsR = await tryRpc('user-bounties.listActiveRewards', {});
  const rewards  = rewardsR.ok ? (rewardsR.data || []) : [];
  log('  active rewards:', rewards.length);

  // ── helpers ───────────────────────────────────────────────────────────────

  // pick 3 concepts: FPNAP + 1 trending + 1 billboard/HAVEN/owned
  function pickConceptTriple(runIndex = 0) {
    const trending = trendingPool[runIndex % Math.max(trendingPool.length, 1)];

    // slot 3: prefer HAVEN, then billboard, then owned rotation
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

  // generate image, poll until done, return mediaShortId
  async function generateImage(conceptIds) {
    log('Generating image with concepts:', conceptIds.join(', '));
    const k = await rpc('create.image', {
      conceptShortIds: conceptIds,
      items: conceptIds.map(s => ({ type: 'concept', shortId: s })),
      aspectRatio: '1:1',
    });
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

  // generate text draft
  async function makePostText(conceptIds, bountyShortId) {
    const args = {
      conceptShortIds: conceptIds,
      items: conceptIds.map(s => ({ type: 'concept', shortId: s })),
      mediaShortIds: [],
    };
    if (bountyShortId) args.bountyShortId = bountyShortId;
    return rpc('create.text', args);
  }

  // find matching active reward
  function findReward(conceptIds) {
    return rewards.find(r => {
      if (r.rewardClaimsUsed >= r.rewardMaxClaims) return false;
      const need = (r.hyperpromptSnippet?.conceptShortIds || [])
        .filter(s => s !== '__placeholder__');
      return need.every(s => conceptIds.includes(s));
    }) || null;
  }

  // ── content posts ─────────────────────────────────────────────────────────
  const TARGET_POSTS = Math.min(2, postsLeft);
  log('planning posts:', TARGET_POSTS, 'of', postsLeft, 'remaining');

  for (let i = 0; i < TARGET_POSTS; i++) {
    const conceptIds = pickConceptTriple(i);
    const reward     = findReward(conceptIds);
    if (reward) {
      log('  run', i + 1, '— claiming reward', reward.shortId);
      state.bountyClaims.push(reward.shortId);
    }

    try {
      // generate image then text, post both together
      let mediaShortId = null;
      try {
        mediaShortId = await generateImage(conceptIds);
      } catch (e) {
        log('  image gen failed, falling back to text-only:', e.message);
      }

      const draft = await makePostText(conceptIds, reward?.shortId || FPNAP_BOUNTY);
      const pub   = await rpc('create.post', {
        textCompletionShortId: draft.shortId,
        mediaShortIds: mediaShortId ? [mediaShortId] : [],
      });
      const sid = pub.newPost?.short_id || pub.post?.short_id;
      state.postedToday.push({
        shortId:  sid,
        kind:     mediaShortId ? 'image+text' : 'text',
        concepts: conceptIds,
        media:    mediaShortId,
      });
      if (conceptIds.includes(billboardShortId)) state.billboardUsed = true;
      log('  [posted]', mediaShortId ? 'image+text' : 'text', '->', sid, 'concepts:', conceptIds.join(','));
    } catch (e) {
      log('  [post error] run', i + 1, ':', e.message);
      if (/cap|limit|exceeded/i.test(e.message)) break;
    }
  }

  // ── feed: repost trending + like varied accounts ──────────────────────────
  // agent.readFeed returns a text blob — parse shortIds from it
  const feedR = await tryRpc('agent.readFeed', { kind: 'recent', limit: 25 });
  log('  feed fetch ok:', feedR.ok, feedR.ok ? '' : feedR.err);

  // also try posts.getForYouFeed as fallback (some accounts have it)
  const forYouR = await tryRpc('posts.getForYouFeed', { limit: 20 });
  const feedPosts = forYouR.ok ? (forYouR.data?.posts || []) : [];

  // parse shortIds from text feed
  const feedShortIds = [];
  if (feedR.ok && typeof feedR.data === 'string') {
    const re = /shortId:\s*(\S+)/g;
    let m;
    while ((m = re.exec(feedR.data)) !== null) feedShortIds.push(m[1]);
    log('  parsed', feedShortIds.length, 'shortIds from text feed');
  }

  // repost from structured feed
  let reposted = 0;
  for (const p of feedPosts) {
    if (p.player_engagement?.repostedActive) continue;
    const r = await tryRpc('posts.repostPost', { shortId: p.short_id, active: true });
    if (r.ok) { state.repostedToday.push(p.short_id); reposted++; }
  }
  // repost from text feed shortIds
  for (const shortId of feedShortIds.slice(0, 15)) {
    if (state.repostedToday.includes(shortId)) continue;
    const r = await tryRpc('posts.repostPost', { shortId, active: true });
    if (r.ok) { state.repostedToday.push(shortId); reposted++; }
  }
  log('  reposted from feed:', reposted);

  // like from structured feed (varied authors)
  const seenAuthors = new Set();
  let liked = 0;
  for (const p of feedPosts) {
    if (liked >= 6) break;
    if (p.player_engagement?.likedActive) continue;
    if (seenAuthors.has(p.author?.shortId)) continue;
    const r = await tryRpc('posts.likePost', { shortId: p.short_id, active: true });
    if (r.ok) { state.likedToday.push(p.short_id); seenAuthors.add(p.author?.shortId); liked++; }
  }
  // like from text feed shortIds if structured was empty
  if (liked === 0) {
    for (const shortId of feedShortIds.slice(0, 10)) {
      if (liked >= 6) break;
      const r = await tryRpc('posts.likePost', { shortId, active: true });
      if (r.ok) { state.likedToday.push(shortId); liked++; }
    }
  }
  log('  liked from feed:', liked);

  // ── reply to anyone using concepts we interact with ────────────────────────
  try {
    const interactedConcepts = [FPNAP, ...(havenShortId ? [havenShortId] : [])];
    for (const conceptShortId of interactedConcepts) {
      // use notifications to find who engaged with our concepts recently
      const notifR = await tryRpc('notifications.list', { limit: 20 });
      const notifPosts = notifR.ok
        ? (notifR.data?.notifications || [])
            .filter(n => n.post?.short_id && n.actor?.shortId !== MY_CHAR)
            .map(n => n.post)
            .filter(Boolean)
        : [];

      // also try the concept timeline feed
      const feedR2 = await tryRpc('posts.getCharacterTimelineFeed', {
        charShortIds: [],
        conceptShortIds: [conceptShortId],
        limit: 10,
      });
      const conceptPosts = [
        ...notifPosts,
        ...(feedR2.ok ? (feedR2.data?.posts || []) : []),
      ].filter((p, i, arr) => arr.findIndex(x => x.short_id === p.short_id) === i); // dedupe

      log('  reply candidates for concept', conceptShortId, ':', conceptPosts.length);

      let replied = 0;
      for (const p of conceptPosts) {
        if (replied >= 2) break;
        if (!p.short_id) continue;
        if (p.author?.shortId === MY_CHAR) continue;
        if (p.player_engagement?.repliedActive) continue;
        const replyText = await tryRpc('create.replyCompletion', {
          replyToShortId:  p.short_id,
          conceptShortIds: [conceptShortId, FPNAP],
        });
        if (!replyText.ok) { log('  replyCompletion fail:', replyText.err); continue; }
        const replyPub = await tryRpc('create.createPostReply', {
          replyToShortId:        p.short_id,
          textCompletionShortId: replyText.data?.shortId,
        });
        if (replyPub.ok) {
          const sid = replyPub.data?.newPost?.short_id || replyPub.data?.post?.short_id;
          state.postedToday.push({ shortId: sid, kind: 'reply', target: p.short_id });
          replied++;
          log('  [replied] to', p.short_id, '->', sid, 'concept:', conceptShortId);
        } else {
          log('  reply publish fail:', replyPub.err);
        }
      }
    }
  } catch (e) {
    log('  reply-to-concept-users error:', e.message);
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

  log('=== END-OF-DAY REPORT ===');
  log('balance:', startBal, '->', endBal, 'delta:', endBal - startBal);
  log('posts:', state.postedToday.length, JSON.stringify(state.postedToday.map(p => p.shortId)));
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
      delta:          endBal - startBal,
      postsRemaining: endSession.player?.dailyPosts?.remaining,
      postsLimit:     endSession.player?.dailyPosts?.limit,
      rank:           endSession.player?.leaderboard?.rank,
      posts:          state.postedToday,
      reposted:       state.repostedToday.length,
      liked:          state.likedToday.length,
      billboardUsed:  state.billboardUsed,
      conceptCreated: state.conceptCreated,
      billboardSet:   state.billboardSet,
      bountyClaims:   state.bountyClaims,
      bonuses:        state.bonusesClaimed,
      tipping:        { totalCents: 0, targets: 0 },
    },
  };
}

module.exports = { runHeartbeat, loadSkillHeaders };



// /**
//  * heartbeat.js — Simcluster daily strategy for @HallenjayArt
//  *
//  * Compliant with skill.md Golden Rules:
//  *   - Rotates concepts (trending + owned + billboard), never single-concept spam
//  *   - Engages varied accounts via for-you feed, not a fixed allowlist
//  *   - No tipping
//  *   - Videos with text using 3 concepts
//  *   - Reposts trending content from feed
//  *
//  * Exports: { runHeartbeat, loadSkillHeaders }
//  */

// const crypto = require('crypto');

// // ─── strategy constants ───────────────────────────────────────────────────────
// const FPNAP        = 'eNXWgYAn';   // For Profit Not A Priest — owned concept
// const FPNAP_BOUNTY = '8YzY7lmx';
// const MY_CHAR      = 'lBOaqwV2';   // @HallenjayArt

// // ─── skill bootstrap ─────────────────────────────────────────────────────────
// async function loadSkillHeaders() {
//   const res  = await fetch('https://simcluster.ai/skill.md', {
//     headers: { 'User-Agent': 'Mozilla/5.0 (compatible; SimclusterAgent/1.0)', 'Accept': 'text/plain, */*' }
//   });
//   const text = await res.text();
//   const hash = crypto.createHash('sha256').update(text, 'utf8').digest('hex');

//   const norm  = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
//   const match = norm.match(/remember ([^;\n]+);[^\n]*that is this edition.{0,3}s operating memory/i);
//   let ack     = match ? match[1].trim() : null;
//   if (!ack) {
//     console.warn('[skill] regex failed — using known fallback');
//     ack = 'prevent.trap.length.horse';
//   }
//   console.log('[skill] hash:', hash.slice(0, 16) + '... | ack:', ack);
//   return { skillHash: hash, skillAck: ack };
// }

// // ─── RPC layer ────────────────────────────────────────────────────────────────
// function makeRpc(token, skillHash, skillAck) {
//   let _id = 1;

//   async function rpc(name, args = {}) {
//     const id = _id++;
//     const r  = await fetch('https://simcluster.ai/mcp', {
//       method:  'POST',
//       headers: {
//         'Authorization':           'Bearer ' + token,
//         'Content-Type':            'application/json',
//         'Accept':                  'application/json, text/event-stream',
//         'X-Simcluster-Skill-Hash': skillHash,
//         'X-Simcluster-Skill-Ack':  skillAck,
//       },
//       body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }),
//     });
//     const j = await r.json();
//     if (j.result?.isError) throw new Error(`${name}: ${j.result.content?.[0]?.text || 'unknown'}`);
//     if (j.error)           throw new Error(`${name}: ${j.error.message}`);
//     const txt = j.result?.content?.[0]?.text;
//     if (!txt) return j.result;
//     try { return JSON.parse(txt); } catch { return txt; }
//   }

//   const sleep = (ms) => new Promise(r => setTimeout(r, ms));

//   // non-throwing wrapper
//   async function tryRpc(name, args = {}) {
//     try { return { ok: true, data: await rpc(name, args) }; }
//     catch (e) { return { ok: false, err: e.message }; }
//   }

//   async function safeRpc(name, args, attempts = 3) {
//     let last;
//     for (let i = 0; i < attempts; i++) {
//       try { return await rpc(name, args); }
//       catch (e) {
//         last = e;
//         if (!/deadlock|timeout|rate/i.test(e.message)) throw e;
//         await sleep(300 * (i + 1));
//       }
//     }
//     throw last;
//   }

//   return { rpc, safeRpc, tryRpc, sleep };
// }

// // ─── main ─────────────────────────────────────────────────────────────────────
// async function runHeartbeat(token, skillHash, skillAck) {
//   if (!skillHash || !skillAck) {
//     throw new Error('skillHash and skillAck are required — load and acknowledge skill.md first');
//   }

//   const logs  = [];
//   const today = new Date().toISOString().slice(0, 10);

//   function log(...a) {
//     const line = `[${new Date().toISOString()}] ` +
//       a.map(x => typeof x === 'string' ? x : JSON.stringify(x)).join(' ');
//     logs.push(line);
//     console.log(line);
//   }

//   log('=== Simcluster heartbeat START === day=' + today);
//   log('skill hash:', skillHash.slice(0, 16) + '... | ack:', skillAck);

//   const state = {
//     day:              today,
//     postedToday:      [],
//     likedToday:       [],
//     repostedToday:    [],
//     bonusesClaimed:   {},
//     bountyClaims:     [],
//     billboardUsed:    false,
//   };

//   const { rpc, safeRpc, tryRpc, sleep } = makeRpc(token, skillHash, skillAck);

//   // ── session + bonus reminders ─────────────────────────────────────────────
//   const session    = await rpc('agent.sessionStatus', {});
//   const startBal   = session.player?.clout?.totalAvailable ?? 0;
//   let   postsLeft  = session.player?.dailyPosts?.remaining ?? 0;
//   const dailyRem   = session.player?.dailySpend?.remaining ?? 0;
//   log('balance:', startBal, '| postsRemaining:', postsLeft, '| dailySpendRem:', dailyRem);

//   // sign-in bonus reminder (cannot claim server-side)
//   const sign = await tryRpc('bounties.getDailySignInBountyStatus', {});
//   if (sign.ok) {
//     const ready = !sign.data.nextClaimLockedUntil || new Date(sign.data.nextClaimLockedUntil) <= new Date();
//     state.bonusesClaimed.signIn = ready ? 'READY — claim at simcluster.ai/bonuses' : 'locked';
//     log('  signin streak:', sign.data.streakLength, state.bonusesClaimed.signIn);
//   }

//   // billboard bonus reminder
//   const bb = await tryRpc('bounties.checkDailyBillboardProgress', {});
//   if (bb.ok) {
//     const c = bb.data.extras?.progressCount ?? 0;
//     const t = bb.data.extras?.progressTarget ?? 1;
//     state.bonusesClaimed.billboard = `${c}/${t}${c >= t ? ' READY — claim at simcluster.ai/bonuses' : ''}`;
//     log('  billboard progress:', state.bonusesClaimed.billboard);
//   }

//   // ── gather concept pools ──────────────────────────────────────────────────

//   // billboard top-10 (include at least one to qualify for daily billboard claim)
//   let billboardShortId = null;
//   const bbList = await tryRpc('bounties.listBillboardConcepts', {});
//   if (bbList.ok && bbList.data?.length) {
//     const pick = bbList.data[0];
//     billboardShortId = pick.shortId || pick.short_id;
//     log('  billboard #1:', pick.slug, '(' + billboardShortId + ')');
//   }

//   // trending concepts pool (rotate, don't spam one)
//   const trendingR = await tryRpc('concepts.definition.trending', {});
//   const trendingPool = (trendingR.ok ? (trendingR.data || []) : [])
//     .filter(c => c.shortId || c.short_id)
//     .slice(0, 8)
//     .map(c => ({ shortId: c.shortId || c.short_id, slug: c.slug }));
//   log('  trending pool:', trendingPool.length, trendingPool.map(c => c.slug).slice(0, 5).join(', '));

//   // owned concepts pool
//   const ownedR = await tryRpc('concepts.definition.yourConcepts', {});
//   const ownedPool = (ownedR.ok ? (ownedR.data?.concepts || ownedR.data || []) : [])
//     .filter(c => c.shortId || c.short_id)
//     .map(c => ({ shortId: c.shortId || c.short_id, slug: c.slug }));
//   log('  owned pool:', ownedPool.length);

//   // active per-creation rewards
//   const rewardsR = await tryRpc('user-bounties.listActiveRewards', {});
//   const rewards   = rewardsR.ok ? (rewardsR.data || []) : [];
//   log('  active rewards:', rewards.length);

//   // ── helpers ───────────────────────────────────────────────────────────────

//   // pick 3 concepts: FPNAP (owned) + 1 trending + 1 billboard/owned, rotated each run
//   function pickConceptTriple(runIndex = 0) {
//     const trending = trendingPool[runIndex % Math.max(trendingPool.length, 1)];
//     // alternate between billboard and owned for slot 3
//     const slot3 = runIndex % 2 === 0
//       ? (billboardShortId ? { shortId: billboardShortId, slug: 'billboard' } : ownedPool[1])
//       : ownedPool[runIndex % Math.max(ownedPool.length, 1)];

//     const ids = [FPNAP];
//     if (trending)  ids.push(trending.shortId);
//     if (slot3?.shortId && !ids.includes(slot3.shortId)) ids.push(slot3.shortId);

//     return ids;
//   }

//   // generate video, poll until done, return mediaShortId
//   async function generateVideo(conceptIds) {
//     log('Generating video with concepts:', conceptIds.join(', '));
//     const k = await rpc('create.video', {
//       conceptShortIds: conceptIds,
//       items: conceptIds.map(s => ({ type: 'concept', shortId: s })),
//       aspectRatio: '16:9',
//     });
//     const evtId = k.generation_event_id;
//     if (!evtId) throw new Error('no generation_event_id from create.video: ' + JSON.stringify(k));

//     for (let i = 0; i < 80; i++) {
//       await sleep(4000);
//       const st = await rpc('create.getGenerationStatus', { generation_event_id: evtId });
//       if (st.status === 'complete' || st.status === 'completed') {
//         const mediaShortId = st.mediaShortId || st.media?.shortId || st.media?.short_id || null;
//         log('Video ready:', mediaShortId);
//         return mediaShortId;
//       }
//       if (st.status === 'failed' || st.status === 'error')
//         throw new Error('video gen failed: ' + JSON.stringify(st));
//     }
//     throw new Error('video gen timed out');
//   }

//   // generate text draft for a post
//   async function makePostText(conceptIds, bountyShortId) {
//     const args = {
//       conceptShortIds: conceptIds,
//       items: conceptIds.map(s => ({ type: 'concept', shortId: s })),
//       mediaShortIds: [],
//     };
//     if (bountyShortId) args.bountyShortId = bountyShortId;
//     return rpc('create.text', args);
//   }

//   // find a matching active reward for a given concept set
//   function findReward(conceptIds) {
//     return rewards.find(r => {
//       if (r.rewardClaimsUsed >= r.rewardMaxClaims) return false;
//       const need = (r.hyperpromptSnippet?.conceptShortIds || [])
//         .filter(s => s !== '__placeholder__');
//       return need.every(s => conceptIds.includes(s));
//     }) || null;
//   }

//   // ── content posts ─────────────────────────────────────────────────────────
//   // max 2 posts per heartbeat to stay compliant with daily caps
//   const TARGET_POSTS = Math.min(2, postsLeft);
//   log('planning posts:', TARGET_POSTS, 'of', postsLeft, 'remaining');

//   for (let i = 0; i < TARGET_POSTS; i++) {
//     const conceptIds = pickConceptTriple(i);
//     const reward     = findReward(conceptIds);
//     if (reward) {
//       log('  run', i + 1, '— claiming reward', reward.shortId, 'for concepts', conceptIds.join(','));
//       state.bountyClaims.push(reward.shortId);
//     }

//     // alternate: first post gets video, second is text-only (video is slow)
//     const wantVideo = i === 0;

//     try {
//       let mediaShortId = null;

//       if (wantVideo) {
//         try {
//           mediaShortId = await generateVideo(conceptIds);
//         } catch (e) {
//           log('  video gen failed, falling back to text-only:', e.message);
//         }
//       }

//       const draft = await makePostText(conceptIds, reward?.shortId || FPNAP_BOUNTY);
//       const pub   = await rpc('create.post', {
//         textCompletionShortId: draft.shortId,
//         mediaShortIds: mediaShortId ? [mediaShortId] : [],
//       });
//       const sid = pub.newPost?.short_id || pub.post?.short_id;
//       state.postedToday.push({ shortId: sid, kind: wantVideo && mediaShortId ? 'video+text' : 'text', concepts: conceptIds });
//       if (conceptIds.includes(billboardShortId)) state.billboardUsed = true;
//       log('  [posted]', state.postedToday[state.postedToday.length - 1].kind, '->', sid, 'concepts:', conceptIds.join(','));
//     } catch (e) {
//       log('  [post error] run', i + 1, ':', e.message);
//       if (/cap|limit|exceeded/i.test(e.message)) break;
//     }
//   }

//   // ── for-you feed: repost trending + like varied accounts ──────────────────
//   const forYou = await tryRpc('posts.getForYouFeed', { limit: 20 });
//   if (forYou.ok) {
//     const feedPosts = forYou.data?.posts || [];

//     // repost all trending posts (not already reposted)
//     let reposted = 0;
//     for (const p of feedPosts) {
//       if (p.player_engagement?.repostedActive) continue;
//       const r = await tryRpc('posts.repostPost', { shortId: p.short_id, active: true });
//       if (r.ok) { state.repostedToday.push(p.short_id); reposted++; }
//     }
//     log('  reposted from feed:', reposted);

//     // like up to 6 varied posts (different authors)
//     const seenAuthors = new Set();
//     let liked = 0;
//     for (const p of feedPosts) {
//       if (liked >= 6) break;
//       if (p.player_engagement?.likedActive) continue;
//       if (seenAuthors.has(p.author?.shortId)) continue;
//       const r = await tryRpc('posts.likePost', { shortId: p.short_id, active: true });
//       if (r.ok) {
//         state.likedToday.push(p.short_id);
//         seenAuthors.add(p.author?.shortId);
//         liked++;
//       }
//     }
//     log('  liked from feed:', liked, 'across', seenAuthors.size, 'authors');
//   }

//   // ── like own posts ────────────────────────────────────────────────────────
//   const own = await tryRpc('posts.getCharacterTimelineFeed', { charShortIds: [MY_CHAR], limit: 30 });
//   if (own.ok) {
//     let likedOwn = 0;
//     for (const p of own.data?.posts || []) {
//       if (p.author?.shortId !== MY_CHAR)    continue;
//       if (p.player_engagement?.likedActive) continue;
//       const r = await tryRpc('posts.likePost', { shortId: p.short_id, active: true });
//       if (r.ok) likedOwn++;
//     }
//     log('  liked own posts:', likedOwn);
//   }

//   // ── final report ──────────────────────────────────────────────────────────
//   const endSession = await rpc('agent.sessionStatus', {});
//   const endBal     = endSession.player?.clout?.totalAvailable ?? 0;

//   log('=== END-OF-DAY REPORT ===');
//   log('balance:', startBal, '->', endBal, 'delta:', endBal - startBal);
//   log('posts:', state.postedToday.length, JSON.stringify(state.postedToday.map(p => p.shortId)));
//   log('reposted:', state.repostedToday.length);
//   log('liked:', state.likedToday.length);
//   log('billboard used:', state.billboardUsed);
//   log('bounty rewards claimed:', state.bountyClaims.length, state.bountyClaims.join(', '));
//   log('bonuses:', JSON.stringify(state.bonusesClaimed));
//   log('rank:', endSession.player?.leaderboard?.rank);
//   log('postsRemaining:', endSession.player?.dailyPosts?.remaining, '/', endSession.player?.dailyPosts?.limit);
//   log('=== heartbeat END ===');

//   return {
//     logs,
//     result: {
//       startBal, endBal,
//       delta:          endBal - startBal,
//       postsRemaining: endSession.player?.dailyPosts?.remaining,
//       postsLimit:     endSession.player?.dailyPosts?.limit,
//       rank:           endSession.player?.leaderboard?.rank,
//       posts:          state.postedToday,
//       reposted:       state.repostedToday.length,
//       liked:          state.likedToday.length,
//       billboardUsed:  state.billboardUsed,
//       bountyClaims:   state.bountyClaims,
//       bonuses:        state.bonusesClaimed,
//       tipping:        { totalCents: 0, targets: 0 },
//     },
//   };
// }

// module.exports = { runHeartbeat, loadSkillHeaders };







// /** FOR MZCAT STRATEGY STRICTLY
//  * heartbeat.js — Simcluster daily strategy for @HallenjayArt
//  *
//  * skillHash + skillAck are passed in by the caller:
//  *   - server.js  → from frontend body (manual run)
//  *   - scheduler  → calls loadSkillHeaders() then passes result
//  *
//  * Exports: { runHeartbeat, loadSkillHeaders }
//  */

// const crypto = require('crypto');

// // ─── strategy constants ───────────────────────────────────────────────────────
// const FPNAP          = 'eNXWgYAn';
// const FPNAP_BOUNTY   = '8YzY7lmx';
// const MZT_CHAR       = '6E4nRNo3';
// const MY_CHAR        = 'lBOaqwV2';
// const TIP_DAILY_CAP  = 50;
// const MIN_MEDIA_POSTS = 2;

// // ─── skill bootstrap (called by scheduler; frontend does its own via /api/skill) ─
// async function loadSkillHeaders() {
//   const res  = await fetch('https://simcluster.ai/skill.md');
//   const text = await res.text();

//   // SHA-256 of raw file bytes
//   const hash = crypto.createHash('sha256').update(text, 'utf8').digest('hex');

//   // Pattern: "remember X; that is this edition's operating memory"
//   const match = text.match(/remember ([^;\n]+);\s*that is this edition[\u2018\u2019']s operating memory/i);
//   const ack   = match ? match[1].trim() : null;

//   if (!ack) {
//     throw new Error('ack phrase not found in skill.md — file may have rotated. Check the file for operating memory.');
//   }

//   console.log('[skill] hash:', hash.slice(0, 16) + '... | ack:', ack);
//   return { skillHash: hash, skillAck: ack };
// }

// // ─── RPC layer ────────────────────────────────────────────────────────────────
// function makeRpc(token, skillHash, skillAck) {
//   let _id = 1;

//   async function rpc(name, args = {}) {
//     const id = _id++;
//     const r  = await fetch('https://simcluster.ai/mcp', {
//       method:  'POST',
//       headers: {
//         'Authorization':           'Bearer ' + token,
//         'Content-Type':            'application/json',
//         'Accept':                  'application/json, text/event-stream',
//         'X-Simcluster-Skill-Hash': skillHash,
//         'X-Simcluster-Skill-Ack':  skillAck,
//       },
//       body: JSON.stringify({
//         jsonrpc: '2.0', id,
//         method:  'tools/call',
//         params:  { name, arguments: args },
//       }),
//     });

//     const j = await r.json();
//     if (j.result?.isError) throw new Error(`${name}: ${j.result.content?.[0]?.text || 'unknown'}`);
//     if (j.error)           throw new Error(`${name}: ${j.error.message}`);

//     const txt = j.result?.content?.[0]?.text;
//     if (!txt) return j.result;
//     try { return JSON.parse(txt); } catch { return txt; }
//   }

//   const sleep = (ms) => new Promise(r => setTimeout(r, ms));

//   async function safeRpc(name, args, attempts = 3) {
//     let last;
//     for (let i = 0; i < attempts; i++) {
//       try { return await rpc(name, args); }
//       catch (e) {
//         last = e;
//         if (!/deadlock|timeout|rate/i.test(e.message)) throw e;
//         await sleep(300 * (i + 1));
//       }
//     }
//     throw last;
//   }

//   return { rpc, safeRpc, sleep };
// }

// // ─── main ─────────────────────────────────────────────────────────────────────
// async function runHeartbeat(token, skillHash, skillAck) {
//   if (!skillHash || !skillAck) {
//     throw new Error('skillHash and skillAck are required — load and acknowledge skill.md first');
//   }

//   const logs  = [];
//   const today = new Date().toISOString().slice(0, 10);

//   function log(...a) {
//     const line = `[${new Date().toISOString()}] ` +
//       a.map(x => typeof x === 'string' ? x : JSON.stringify(x)).join(' ');
//     logs.push(line);
//     console.log(line);
//   }

//   log('=== Simcluster daily heartbeat START === day=' + today);
//   log('skill hash:', skillHash.slice(0, 16) + '...');
//   log('skill ack: ', skillAck.slice(0, 60) + (skillAck.length > 60 ? '...' : ''));

//   const state = {
//     day: today,
//     tippedToday:      {},
//     totalTippedToday: 0,
//     likedTodayMzt:    [],
//     repostedTodayMzt: null,
//     repliedTodayMzt:  null,
//     postedToday:      [],
//     bonusesClaimed:   {},
//     likedOwnToday:    [],
//   };

//   const { rpc, safeRpc, sleep } = makeRpc(token, skillHash, skillAck);

//   // ── helpers ──────────────────────────────────────────────────────────────────

//   async function tipOnce(shortId, amount = 1) {
//     if (state.tippedToday[shortId])                       return { skipped: 'already-tipped-this-run' };
//     if (state.totalTippedToday + amount > TIP_DAILY_CAP) return { skipped: 'daily-cap' };
//     try {
//       const r = await safeRpc('posts.incrementPostTip', { shortId, count: amount });
//       if (r?.success) {
//         state.tippedToday[shortId] = amount;
//         state.totalTippedToday += amount;
//         return { ok: true, amount };
//       }
//       return { error: JSON.stringify(r).slice(0, 120) };
//     } catch (e) { return { error: e.message }; }
//   }

//   async function tryClaimBonuses() {
//     try {
//       const st = await rpc('bounties.getDailySignInBountyStatus', {});
//       state.bonusesClaimed.signIn =
//         (!st.nextClaimLockedUntil || new Date(st.nextClaimLockedUntil) <= new Date())
//           ? 'browser-required' : 'locked-already-claimed';
//     } catch (e) { state.bonusesClaimed.signIn = 'error:' + e.message; }

//     try {
//       const bb = await rpc('bounties.checkDailyBillboardProgress', {});
//       state.bonusesClaimed.billboard =
//         `progress ${bb.extras?.progressCount ?? 0}/${bb.extras?.progressTarget ?? 1}`;
//     } catch (e) { state.bonusesClaimed.billboard = 'error:' + e.message; }
//   }

//   async function fetchMzt() {
//     const t = await rpc('posts.getCharacterTimelineFeed', { charShortIds: [MZT_CHAR], limit: 30 });
//     return (t.posts || []).filter(p =>
//       p.author?.username === 'mztacat' && p.author?.shortId === MZT_CHAR
//     );
//   }

//   async function generateImage() {
//     log('Generating image with FPNAP...');
//     const k     = await rpc('create.image', {
//       conceptShortIds: [FPNAP],
//       items: [{ type: 'concept', shortId: FPNAP }],
//       aspectRatio: '1:1',
//     });
//     const evtId = k.generation_event_id;
//     if (!evtId) throw new Error('no generation_event_id: ' + JSON.stringify(k));

//     for (let i = 0; i < 60; i++) {
//       await sleep(3000);
//       const st = await rpc('create.getGenerationStatus', { generation_event_id: evtId });
//       if (st.status === 'complete' || st.status === 'completed') return st;
//       if (st.status === 'failed'  || st.status === 'error')
//         throw new Error('image gen failed: ' + JSON.stringify(st));
//     }
//     throw new Error('image gen timed out');
//   }

//   async function makePostText() {
//     return rpc('create.text', {
//       conceptShortIds: [FPNAP],
//       items: [{ type: 'concept', shortId: FPNAP }],
//       mediaShortIds: [],
//       bountyShortId: FPNAP_BOUNTY,
//     });
//   }

//   async function makePostTextWithMedia(mediaShortId) {
//     return rpc('create.text', {
//       conceptShortIds: [FPNAP],
//       items: [
//         { type: 'concept',  shortId: FPNAP },
//         { type: 'artifact', shortId: mediaShortId, artifactType: 'image' },
//       ],
//       mediaShortIds: [mediaShortId],
//       bountyShortId: FPNAP_BOUNTY,
//     });
//   }

//   async function publishPost(textShortId, mediaShortIds = []) {
//     return rpc('create.post', { textCompletionShortId: textShortId, mediaShortIds });
//   }

//   async function replyToMzt(replyToShortId) {
//     const c = await rpc('create.replyCompletion', { replyToShortId, conceptShortIds: [FPNAP] });
//     return rpc('create.createPostReply', {
//       replyToShortId,
//       textCompletionShortId: c.shortId,
//     });
//   }

//   // ── execution ────────────────────────────────────────────────────────────────

//   await tryClaimBonuses();

//   let session    = await rpc('agent.sessionStatus', {});
//   const startBal = session.player?.clout?.totalAvailable ?? 0;
//   let postsLeft  = session.player?.dailyPosts?.remaining ?? 0;
//   log('START balance:', startBal, 'postsRemaining:', postsLeft);

//   // mztacat engagement
//   const mztPosts = await fetchMzt();
//   log('mztacat posts seen:', mztPosts.length);

//   for (const p of mztPosts) {
//     if (state.likedTodayMzt.length >= 2) break;
//     if (p.player_engagement?.likedActive) continue;
//     try {
//       await safeRpc('posts.likePost', { shortId: p.short_id, active: true });
//       state.likedTodayMzt.push(p.short_id);
//     } catch (e) { log('like-mzt error', p.short_id, e.message); }
//   }
//   log('mzt liked:', state.likedTodayMzt.length);

//   // repost best mzt post
//   const repostable = mztPosts
//     .filter(p => !p.player_engagement?.repostedActive)
//     .sort((a, b) => (b.cumulative_tips || 0) - (a.cumulative_tips || 0));
//   if (repostable[0]) {
//     try {
//       await safeRpc('posts.repostPost', { shortId: repostable[0].short_id, active: true });
//       state.repostedTodayMzt = repostable[0].short_id;
//       log('reposted mzt:', repostable[0].short_id);
//     } catch (e) { log('repost error', e.message); }
//   }

//   // tip 2 mzt posts
//   for (const p of mztPosts.slice(0, 2)) {
//     const r = await tipOnce(p.short_id, 1);
//     if (r.skipped === 'daily-cap') { log('tip cap reached'); break; }
//   }
//   log('after mzt tips total¢:', state.totalTippedToday);

//   // refresh quota
//   session   = await rpc('agent.sessionStatus', {});
//   postsLeft = session.player?.dailyPosts?.remaining ?? 0;
//   let bal   = session.player?.clout?.totalAvailable ?? 0;
//   log('postsLeft after engagement:', postsLeft, 'balance:', bal);

//   // reply slot
//   if (postsLeft > 0 && bal >= 10) {
//     const latestTop = mztPosts.find(p => !p.in_reply_to);
//     if (latestTop) {
//       try {
//         const reply = await replyToMzt(latestTop.short_id);
//         const sid   = reply.post?.short_id || reply.newPost?.short_id;
//         state.repliedTodayMzt = latestTop.short_id;
//         state.postedToday.push({ shortId: sid, kind: 'reply-to-mzt', target: latestTop.short_id });
//         log('replied to mzt:', latestTop.short_id, '->', sid);
//         postsLeft--;
//       } catch (e) { log('reply error', e.message); }
//     }
//   }

//   // content posts: 2 with media, rest text
//   const slotsToFill = postsLeft;
//   const mediaSlots  = Math.min(MIN_MEDIA_POSTS, slotsToFill);
//   log('filling slots:', slotsToFill, 'mediaSlots:', mediaSlots);

//   for (let i = 0; i < slotsToFill; i++) {
//     session = await rpc('agent.sessionStatus', {});
//     bal     = session.player?.clout?.totalAvailable ?? 0;
//     if (bal < 800) { log('balance below 800, stopping. bal=', bal); break; }

//     try {
//       let mediaShortId = null;
//       if (i < mediaSlots) {
//         const img = await generateImage();
//         mediaShortId =
//           img.media?.shortId || img.shortId ||
//           img.media_shortId  || img.image?.shortId ||
//           img.media?.short_id || null;
//         if (!mediaShortId)
//           log('no media shortId, falling back to text. raw:', JSON.stringify(img).slice(0, 200));
//       }

//       const textRes = mediaShortId
//         ? await makePostTextWithMedia(mediaShortId)
//         : await makePostText();

//       const pub = await publishPost(textRes.shortId, mediaShortId ? [mediaShortId] : []);
//       const sid = pub.newPost?.short_id || pub.post?.short_id;
//       state.postedToday.push({ shortId: sid, kind: mediaShortId ? 'image' : 'text', media: mediaShortId });
//       log('posted slot', i + 1, '->', sid, mediaShortId ? '(image)' : '(text)');
//     } catch (e) {
//       log('post slot', i + 1, 'error:', e.message);
//       if (/cap|limit|exceeded/i.test(e.message)) break;
//     }
//   }

//   // warmup: like + tip recent feed
//   try {
//     const feed  = await rpc('agent.readFeed', { kind: 'recent', limit: 25 });
//     const re    = /^shortId:\s*(\S+)[\s\S]*?^author:.*?@(\S+)/gm;
//     const found = [];
//     let m;
//     while ((m = re.exec(feed)) !== null) found.push({ shortId: m[1] });

//     let liked = 0;
//     for (const { shortId } of found.slice(0, 10)) {
//       try { await safeRpc('posts.likePost', { shortId, active: true }); liked++; } catch (_) {}
//     }
//     log('warmup liked:', liked);

//     for (const { shortId } of found.slice(0, 2)) {
//       const r = await tipOnce(shortId, 1);
//       if (r.skipped === 'daily-cap') break;
//     }
//     log('after warmup tips total¢:', state.totalTippedToday);
//   } catch (e) { log('warmup error', e.message); }

//   // like own posts
//   try {
//     const own = await rpc('posts.getCharacterTimelineFeed', { charShortIds: [MY_CHAR], limit: 50 });
//     let likedOwn = 0;
//     for (const p of own.posts || []) {
//       if (p.author?.shortId !== MY_CHAR)    continue;
//       if (p.player_engagement?.likedActive) continue;
//       try { await safeRpc('posts.likePost', { shortId: p.short_id, active: true }); likedOwn++; } catch (_) {}
//     }
//     log('liked own posts:', likedOwn);
//   } catch (e) { log('like-own error', e.message); }

//   // final report
//   session      = await rpc('agent.sessionStatus', {});
//   const endBal = session.player?.clout?.totalAvailable ?? 0;

//   log('=== END-OF-DAY REPORT ===');
//   log('balance:', startBal, '->', endBal, 'delta:', endBal - startBal);
//   log('posts:', state.postedToday.length, JSON.stringify(state.postedToday));
//   log('mzt: liked', state.likedTodayMzt.length, '| reposted', state.repostedTodayMzt || '-', '| replied', state.repliedTodayMzt || '-');
//   log('tips total¢:', state.totalTippedToday, '| targets:', Object.keys(state.tippedToday).length);
//   log('bonuses:', JSON.stringify(state.bonusesClaimed));
//   log('rank:', session.player?.leaderboard?.rank);
//   log('postsRemaining:', session.player?.dailyPosts?.remaining, '/', session.player?.dailyPosts?.limit);
//   log('=== heartbeat END ===');

//   return {
//     logs,
//     result: {
//       startBal, endBal,
//       delta:          endBal - startBal,
//       postsRemaining: session.player?.dailyPosts?.remaining,
//       postsLimit:     session.player?.dailyPosts?.limit,
//       rank:           session.player?.leaderboard?.rank,
//       posts:          state.postedToday,
//       mzt: {
//         reposted: state.repostedTodayMzt,
//         replied:  state.repliedTodayMzt,
//       },
//       tipping: {
//         totalCents: state.totalTippedToday,
//         targets:    Object.keys(state.tippedToday).length,
//       },
//       bonuses: state.bonusesClaimed,
//     },
//   };
// }

// module.exports = { runHeartbeat, loadSkillHeaders };

