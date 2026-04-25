/**
 * heartbeat.js — Simcluster daily strategy for @HallenjayArt
 *
 * Pure module. Token is injected by the caller (server.js / scheduler).
 * No dotenv, no process.exit, no onboarding logic.
 *
 * Export: runHeartbeat(token) → Promise<{ logs: string[], result: object }>
 */

// --- strategy constants ---
const FPNAP        = 'eNXWgYAn';   // For Profit Not A Priest concept
const FPNAP_BOUNTY = '8YzY7lmx';
const MZT_CHAR     = '6E4nRNo3';   // @mztacat character
const MY_CHAR      = 'lBOaqwV2';   // @HallenjayArt
const TIP_DAILY_CAP  = 50;         // total tips per day (¢)
const MIN_MEDIA_POSTS = 2;         // at least 2 of 5 posts with media

// ─────────────────────────────────────────────────────────────────────────────
// RPC layer
// ─────────────────────────────────────────────────────────────────────────────

const crypto = require('crypto');

// Fetch skill.md, SHA-256 hash it, extract ack phrase.
// Simcluster requires these headers on every protected MCP call.
async function loadSkill() {
  const res  = await fetch('https://simcluster.ai/skill.md');
  const text = await res.text();
  const hash = crypto.createHash('sha256').update(text).digest('hex');
  const ack  = (text.match(/^(I [^\n]{10,})/m) || [])[1]?.trim() || '';
  return { hash, ack };
}

function makeRpc(token, skillHash, skillAck) {
  let _id = 1;

  async function rpc(name, args = {}) {
    const id = _id++;
    const r = await fetch('https://simcluster.ai/mcp', {
      method: 'POST',
      headers: {
        'Authorization':           'Bearer ' + token,
        'Content-Type':            'application/json',
        'Accept':                  'application/json, text/event-stream',
        'X-Simcluster-Skill-Hash': skillHash,
        'X-Simcluster-Skill-Ack':  skillAck,
      },
      body: JSON.stringify({
        jsonrpc: '2.0', id,
        method: 'tools/call',
        params: { name, arguments: args },
      }),
    });

    const j = await r.json();
    if (j.result?.isError) throw new Error(`${name}: ${j.result.content?.[0]?.text || 'unknown'}`);
    if (j.error)           throw new Error(`${name}: ${j.error.message}`);

    const txt = j.result?.content?.[0]?.text;
    if (!txt) return j.result;
    try { return JSON.parse(txt); } catch { return txt; }
  }

  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

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

  return { rpc, safeRpc, sleep };
}

// ─────────────────────────────────────────────────────────────────────────────
// Main exported function
// ─────────────────────────────────────────────────────────────────────────────

async function runHeartbeat(token) {
  const logs   = [];
  const today  = new Date().toISOString().slice(0, 10);

  function log(...a) {
    const line = `[${new Date().toISOString()}] ` +
      a.map(x => typeof x === 'string' ? x : JSON.stringify(x)).join(' ');
    logs.push(line);
    console.log(line);
  }

  // per-run state
  const state = {
    day: today,
    tippedToday: {},
    totalTippedToday: 0,
    likedTodayMzt: [],
    repostedTodayMzt: null,
    repliedTodayMzt: null,
    postedToday: [],
    bonusesClaimed: {},
    likedOwnToday: [],
  };

  // fetch skill.md and compute required headers
  log('Loading skill.md for MCP auth headers...');
  const { hash: skillHash, ack: skillAck } = await loadSkill();
  log('skill hash:', skillHash.slice(0, 12) + '...', '| ack:', skillAck.slice(0, 40) + '...');

  const { rpc, safeRpc, sleep } = makeRpc(token, skillHash, skillAck);

  // ── helpers ────────────────────────────────────────────────────────────────

  async function tipOnce(shortId, amount = 1) {
    if (state.tippedToday[shortId])                           return { skipped: 'already-tipped-this-run' };
    if (state.totalTippedToday + amount > TIP_DAILY_CAP)     return { skipped: 'daily-cap' };
    try {
      const r = await safeRpc('posts.incrementPostTip', { shortId, count: amount });
      if (r?.success) {
        state.tippedToday[shortId] = amount;
        state.totalTippedToday += amount;
        return { ok: true, amount };
      }
      return { error: JSON.stringify(r).slice(0, 120) };
    } catch (e) { return { error: e.message }; }
  }

  async function tryClaimBonuses() {
    try {
      const st = await rpc('bounties.getDailySignInBountyStatus', {});
      if (!st.nextClaimLockedUntil || new Date(st.nextClaimLockedUntil) <= new Date()) {
        log('SIGN-IN bonus: browser claim required (MCP endpoint not exposed).');
        state.bonusesClaimed.signIn = 'browser-required';
      } else {
        state.bonusesClaimed.signIn = 'locked-already-claimed';
        log('SIGN-IN already claimed (locked until', st.nextClaimLockedUntil, ')');
      }
    } catch (e) { state.bonusesClaimed.signIn = 'error:' + e.message; }

    try {
      const bb = await rpc('bounties.checkDailyBillboardProgress', {});
      state.bonusesClaimed.billboard =
        `progress ${bb.extras?.progressCount ?? 0}/${bb.extras?.progressTarget ?? 1}`;
    } catch (e) { state.bonusesClaimed.billboard = 'error:' + e.message; }
  }

  async function fetchMzt() {
    const t = await rpc('posts.getCharacterTimelineFeed', { charShortIds: [MZT_CHAR], limit: 30 });
    return (t.posts || []).filter(p =>
      p.author?.username === 'mztacat' && p.author?.shortId === MZT_CHAR
    );
  }

  async function generateImage() {
    log('Generating image with FPNAP…');
    const k = await rpc('create.image', {
      conceptShortIds: [FPNAP],
      items: [{ type: 'concept', shortId: FPNAP }],
      aspectRatio: '1:1',
    });
    const evtId = k.generation_event_id;
    if (!evtId) throw new Error('no generation_event_id: ' + JSON.stringify(k));

    for (let i = 0; i < 60; i++) {
      await sleep(3000);
      const st = await rpc('create.getGenerationStatus', { generation_event_id: evtId });
      if (st.status === 'complete' || st.status === 'completed') return st;
      if (st.status === 'failed'  || st.status === 'error')
        throw new Error('image gen failed: ' + JSON.stringify(st));
    }
    throw new Error('image gen timed out');
  }

  async function makePostText() {
    return rpc('create.text', {
      conceptShortIds: [FPNAP],
      items: [{ type: 'concept', shortId: FPNAP }],
      mediaShortIds: [],
      bountyShortId: FPNAP_BOUNTY,
    });
  }

  async function makePostTextWithMedia(mediaShortId) {
    return rpc('create.text', {
      conceptShortIds: [FPNAP],
      items: [
        { type: 'concept',  shortId: FPNAP },
        { type: 'artifact', shortId: mediaShortId, artifactType: 'image' },
      ],
      mediaShortIds: [mediaShortId],
      bountyShortId: FPNAP_BOUNTY,
    });
  }

  async function publishPost(textShortId, mediaShortIds = []) {
    return rpc('create.post', { textCompletionShortId: textShortId, mediaShortIds });
  }

  async function replyToMzt(replyToShortId) {
    const c = await rpc('create.replyCompletion', { replyToShortId, conceptShortIds: [FPNAP] });
    return rpc('create.createPostReply', {
      replyToShortId,
      textCompletionShortId: c.shortId,
    });
  }

  // ── execution ──────────────────────────────────────────────────────────────

  log('=== Simcluster daily heartbeat START ===', 'day=' + today);

  await tryClaimBonuses();

  let session    = await rpc('agent.sessionStatus', {});
  const startBal = session.player?.clout?.totalAvailable ?? 0;
  let postsLeft  = session.player?.dailyPosts?.remaining ?? 0;
  log('START balance:', startBal, 'postsRemaining:', postsLeft);

  // ── mztacat engagement ─────────────────────────────────────────────────────
  const mztPosts = await fetchMzt();
  log('mztacat posts seen:', mztPosts.length);

  for (const p of mztPosts) {
    if (state.likedTodayMzt.length >= 2) break;          // cap at 2 likes
    if (p.player_engagement?.likedActive) continue;
    try {
      await safeRpc('posts.likePost', { shortId: p.short_id, active: true });
      state.likedTodayMzt.push(p.short_id);
    } catch (e) { log('like-mzt error', p.short_id, e.message); }
  }
  log('mzt liked this run:', state.likedTodayMzt.length);

  // repost highest-tip mzt post
  const repostable = mztPosts
    .filter(p => !p.player_engagement?.repostedActive)
    .sort((a, b) => (b.cumulative_tips || 0) - (a.cumulative_tips || 0));
  if (repostable[0]) {
    try {
      await safeRpc('posts.repostPost', { shortId: repostable[0].short_id, active: true });
      state.repostedTodayMzt = repostable[0].short_id;
      log('reposted mzt best:', repostable[0].short_id);
    } catch (e) { log('repost error', e.message); }
  }

  // tip mzt posts 1¢ each — max 2 posts
  for (const p of mztPosts.slice(0, 2)) {
    const r = await tipOnce(p.short_id, 1);
    if (r.skipped === 'daily-cap') { log('tip cap reached'); break; }
  }
  log('after mzt tips totalTipped¢:', state.totalTippedToday);

  // ── refresh quota ──────────────────────────────────────────────────────────
  session   = await rpc('agent.sessionStatus', {});
  postsLeft = session.player?.dailyPosts?.remaining ?? 0;
  let bal   = session.player?.clout?.totalAvailable ?? 0;
  log('postsLeft after engagement:', postsLeft, 'balance:', bal);

  // ── reply slot ─────────────────────────────────────────────────────────────
  if (postsLeft > 0 && bal >= 10) {
    const latestTop = mztPosts.find(p => !p.in_reply_to);
    if (latestTop) {
      try {
        const reply = await replyToMzt(latestTop.short_id);
        const sid   = reply.post?.short_id || reply.newPost?.short_id;
        state.repliedTodayMzt = latestTop.short_id;
        state.postedToday.push({ shortId: sid, kind: 'reply-to-mzt', target: latestTop.short_id });
        log('replied to mzt latest', latestTop.short_id, '->', sid);
        postsLeft--;
      } catch (e) { log('reply error', e.message); }
    }
  }

  // ── content posts: 2 with media, rest text ─────────────────────────────────
  const slotsToFill = postsLeft;
  const mediaSlots  = Math.min(MIN_MEDIA_POSTS, slotsToFill);
  log('filling slots:', slotsToFill, 'mediaSlots:', mediaSlots);

  for (let i = 0; i < slotsToFill; i++) {
    session = await rpc('agent.sessionStatus', {});
    bal     = session.player?.clout?.totalAvailable ?? 0;
    if (bal < 20) { log('balance below 20¢, stopping. bal=', bal); break; }

    const wantMedia = i < mediaSlots;
    try {
      let mediaShortId = null;
      if (wantMedia) {
        const img = await generateImage();
        mediaShortId =
          img.media?.shortId  || img.shortId       ||
          img.media_shortId   || img.image?.shortId ||
          img.media?.short_id || null;
        if (!mediaShortId)
          log('no media shortId, falling back to text. raw:', JSON.stringify(img).slice(0, 300));
      }

      const textRes = mediaShortId
        ? await makePostTextWithMedia(mediaShortId)
        : await makePostText();

      const pub = await publishPost(textRes.shortId, mediaShortId ? [mediaShortId] : []);
      const sid = pub.newPost?.short_id || pub.post?.short_id;

      state.postedToday.push({ shortId: sid, kind: mediaShortId ? 'image' : 'text', media: mediaShortId });
      log('posted slot', i + 1, '->', sid, mediaShortId ? '(with image)' : '(text)');
    } catch (e) {
      log('post slot', i + 1, 'error:', e.message);
      if (/cap|limit|exceeded/i.test(e.message)) break;
    }
  }

  // ── warmup: like + tip recent feed ────────────────────────────────────────
  try {
    const feed = await rpc('agent.readFeed', { kind: 'recent', limit: 25 });
    const re   = /^shortId:\s*(\S+)[\s\S]*?^author:.*?@(\S+)/gm;
    const found = [];
    let m;
    while ((m = re.exec(feed)) !== null) found.push({ shortId: m[1], username: m[2] });

    let liked = 0;
    for (const { shortId } of found.slice(0, 10)) {
      try { await safeRpc('posts.likePost', { shortId, active: true }); liked++; } catch (_) {}
    }
    log('warmup liked feed posts:', liked);

    for (const { shortId } of found.slice(0, 5)) {
      const r = await tipOnce(shortId, 1);
      if (r.skipped === 'daily-cap') break;
    }
    log('after warmup tips totalTipped¢:', state.totalTippedToday);
  } catch (e) { log('warmup error', e.message); }

  // ── like own posts ─────────────────────────────────────────────────────────
  try {
    const own = await rpc('posts.getCharacterTimelineFeed', { charShortIds: [MY_CHAR], limit: 50 });
    let likedOwn = 0;
    for (const p of own.posts || []) {
      if (p.author?.shortId !== MY_CHAR)      continue;
      if (p.player_engagement?.likedActive)   continue;
      try {
        await safeRpc('posts.likePost', { shortId: p.short_id, active: true });
        likedOwn++;
        state.likedOwnToday.push(p.short_id);
      } catch (_) {}
    }
    log('liked own posts:', likedOwn);
  } catch (e) { log('like-own error', e.message); }

  // ── final report ───────────────────────────────────────────────────────────
  session       = await rpc('agent.sessionStatus', {});
  const endBal  = session.player?.clout?.totalAvailable ?? 0;

  log('=== END-OF-DAY REPORT ===');
  log('balance start:', startBal, '-> end:', endBal, 'delta:', endBal - startBal);
  log('posts made this run:', state.postedToday.length, JSON.stringify(state.postedToday));
  log('mzt: liked', state.likedTodayMzt.length, '| reposted', state.repostedTodayMzt || '-', '| replied to', state.repliedTodayMzt || '-');
  log('tipping: total¢', state.totalTippedToday, '| targets', Object.keys(state.tippedToday).length);
  log('bonuses:', JSON.stringify(state.bonusesClaimed));
  log('rank:', session.player?.leaderboard?.rank);
  log('postsRemaining:', session.player?.dailyPosts?.remaining, '/', session.player?.dailyPosts?.limit);
  log('=== heartbeat END ===');

  return {
    logs,
    result: {
      startBal, endBal,
      delta: endBal - startBal,
      postsRemaining: session.player?.dailyPosts?.remaining,
      postsLimit:     session.player?.dailyPosts?.limit,
      rank:           session.player?.leaderboard?.rank,
      posts:          state.postedToday,
      mzt: {
        liked:    state.likedTodayMzt.length,
        reposted: state.repostedTodayMzt,
        replied:  state.repliedTodayMzt,
      },
      tipping: {
        totalCents: state.totalTippedToday,
        targets:    Object.keys(state.tippedToday).length,
      },
      bonuses: state.bonusesClaimed,
    },
  };
}

module.exports = { runHeartbeat };
// /**
//  * heartbeat.js — Simcluster daily strategy for @HallenjayArt
//  *
//  * Pure module. Token is injected by the caller (server.js / scheduler).
//  * No dotenv, no process.exit, no onboarding logic.
//  *
//  * Export: runHeartbeat(token) → Promise<{ logs: string[], result: object }>
//  */

// // --- strategy constants ---
// const FPNAP        = 'eNXWgYAn';   // For Profit Not A Priest concept
// const FPNAP_BOUNTY = '8YzY7lmx';
// const MZT_CHAR     = '6E4nRNo3';   // @mztacat character
// const MY_CHAR      = 'lBOaqwV2';   // @HallenjayArt
// const TIP_DAILY_CAP  = 50;         // total tips per day (¢)
// const MIN_MEDIA_POSTS = 2;         // at least 2 of 5 posts with media

// // ─────────────────────────────────────────────────────────────────────────────
// // RPC layer
// // ─────────────────────────────────────────────────────────────────────────────

// function makeRpc(token) {
//   let _id = 1;

//   async function rpc(name, args = {}) {
//     const id = _id++;
//     const r = await fetch('https://simcluster.ai/mcp', {
//       method: 'POST',
//       headers: {
//         'Authorization': 'Bearer ' + token,
//         'Content-Type': 'application/json',
//         'Accept': 'application/json, text/event-stream',
//       },
//       body: JSON.stringify({
//         jsonrpc: '2.0', id,
//         method: 'tools/call',
//         params: { name, arguments: args },
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

// // ─────────────────────────────────────────────────────────────────────────────
// // Main exported function
// // ─────────────────────────────────────────────────────────────────────────────

// async function runHeartbeat(token) {
//   const logs   = [];
//   const today  = new Date().toISOString().slice(0, 10);

//   function log(...a) {
//     const line = `[${new Date().toISOString()}] ` +
//       a.map(x => typeof x === 'string' ? x : JSON.stringify(x)).join(' ');
//     logs.push(line);
//     console.log(line);
//   }

//   // per-run state
//   const state = {
//     day: today,
//     tippedToday: {},
//     totalTippedToday: 0,
//     likedTodayMzt: [],
//     repostedTodayMzt: null,
//     repliedTodayMzt: null,
//     postedToday: [],
//     bonusesClaimed: {},
//     likedOwnToday: [],
//   };

//   const { rpc, safeRpc, sleep } = makeRpc(token);

//   // ── helpers ────────────────────────────────────────────────────────────────

//   async function tipOnce(shortId, amount = 1) {
//     if (state.tippedToday[shortId])                           return { skipped: 'already-tipped-this-run' };
//     if (state.totalTippedToday + amount > TIP_DAILY_CAP)     return { skipped: 'daily-cap' };
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
//       if (!st.nextClaimLockedUntil || new Date(st.nextClaimLockedUntil) <= new Date()) {
//         log('SIGN-IN bonus: browser claim required (MCP endpoint not exposed).');
//         state.bonusesClaimed.signIn = 'browser-required';
//       } else {
//         state.bonusesClaimed.signIn = 'locked-already-claimed';
//         log('SIGN-IN already claimed (locked until', st.nextClaimLockedUntil, ')');
//       }
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
//     log('Generating image with FPNAP…');
//     const k = await rpc('create.image', {
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

//   // ── execution ──────────────────────────────────────────────────────────────

//   log('=== Simcluster daily heartbeat START ===', 'day=' + today);

//   await tryClaimBonuses();

//   let session    = await rpc('agent.sessionStatus', {});
//   const startBal = session.player?.clout?.totalAvailable ?? 0;
//   let postsLeft  = session.player?.dailyPosts?.remaining ?? 0;
//   log('START balance:', startBal, 'postsRemaining:', postsLeft);

//   // ── mztacat engagement ─────────────────────────────────────────────────────
//   const mztPosts = await fetchMzt();
//   log('mztacat posts seen:', mztPosts.length);

//   for (const p of mztPosts) {
//     if (p.player_engagement?.likedActive) continue;
//     try {
//       await safeRpc('posts.likePost', { shortId: p.short_id, active: true });
//       state.likedTodayMzt.push(p.short_id);
//     } catch (e) { log('like-mzt error', p.short_id, e.message); }
//   }
//   log('mzt liked this run:', state.likedTodayMzt.length);

//   // repost highest-tip mzt post
//   const repostable = mztPosts
//     .filter(p => !p.player_engagement?.repostedActive)
//     .sort((a, b) => (b.cumulative_tips || 0) - (a.cumulative_tips || 0));
//   if (repostable[0]) {
//     try {
//       await safeRpc('posts.repostPost', { shortId: repostable[0].short_id, active: true });
//       state.repostedTodayMzt = repostable[0].short_id;
//       log('reposted mzt best:', repostable[0].short_id);
//     } catch (e) { log('repost error', e.message); }
//   }

//   // tip mzt posts 1¢ each
//   for (const p of mztPosts) {
//     const r = await tipOnce(p.short_id, 1);
//     if (r.skipped === 'daily-cap') { log('tip cap reached'); break; }
//   }
//   log('after mzt tips totalTipped¢:', state.totalTippedToday);

//   // ── refresh quota ──────────────────────────────────────────────────────────
//   session   = await rpc('agent.sessionStatus', {});
//   postsLeft = session.player?.dailyPosts?.remaining ?? 0;
//   let bal   = session.player?.clout?.totalAvailable ?? 0;
//   log('postsLeft after engagement:', postsLeft, 'balance:', bal);

//   // ── reply slot ─────────────────────────────────────────────────────────────
//   if (postsLeft > 0 && bal >= 10) {
//     const latestTop = mztPosts.find(p => !p.in_reply_to);
//     if (latestTop) {
//       try {
//         const reply = await replyToMzt(latestTop.short_id);
//         const sid   = reply.post?.short_id || reply.newPost?.short_id;
//         state.repliedTodayMzt = latestTop.short_id;
//         state.postedToday.push({ shortId: sid, kind: 'reply-to-mzt', target: latestTop.short_id });
//         log('replied to mzt latest', latestTop.short_id, '->', sid);
//         postsLeft--;
//       } catch (e) { log('reply error', e.message); }
//     }
//   }

//   // ── content posts: 2 with media, rest text ─────────────────────────────────
//   const slotsToFill = postsLeft;
//   const mediaSlots  = Math.min(MIN_MEDIA_POSTS, slotsToFill);
//   log('filling slots:', slotsToFill, 'mediaSlots:', mediaSlots);

//   for (let i = 0; i < slotsToFill; i++) {
//     session = await rpc('agent.sessionStatus', {});
//     bal     = session.player?.clout?.totalAvailable ?? 0;
//     if (bal < 800) { log('balance below 800¢, stopping. bal=', bal); break; }

//     const wantMedia = i < mediaSlots;
//     try {
//       let mediaShortId = null;
//       if (wantMedia) {
//         const img = await generateImage();
//         mediaShortId =
//           img.media?.shortId  || img.shortId       ||
//           img.media_shortId   || img.image?.shortId ||
//           img.media?.short_id || null;
//         if (!mediaShortId)
//           log('no media shortId, falling back to text. raw:', JSON.stringify(img).slice(0, 300));
//       }

//       const textRes = mediaShortId
//         ? await makePostTextWithMedia(mediaShortId)
//         : await makePostText();

//       const pub = await publishPost(textRes.shortId, mediaShortId ? [mediaShortId] : []);
//       const sid = pub.newPost?.short_id || pub.post?.short_id;

//       state.postedToday.push({ shortId: sid, kind: mediaShortId ? 'image' : 'text', media: mediaShortId });
//       log('posted slot', i + 1, '->', sid, mediaShortId ? '(with image)' : '(text)');
//     } catch (e) {
//       log('post slot', i + 1, 'error:', e.message);
//       if (/cap|limit|exceeded/i.test(e.message)) break;
//     }
//   }

//   // ── warmup: like + tip recent feed ────────────────────────────────────────
//   try {
//     const feed = await rpc('agent.readFeed', { kind: 'recent', limit: 25 });
//     const re   = /^shortId:\s*(\S+)[\s\S]*?^author:.*?@(\S+)/gm;
//     const found = [];
//     let m;
//     while ((m = re.exec(feed)) !== null) found.push({ shortId: m[1], username: m[2] });

//     let liked = 0;
//     for (const { shortId } of found.slice(2)) {
//       try { await safeRpc('posts.likePost', { shortId, active: true }); liked++; } catch (_) {}
//     }
//     log('warmup liked feed posts:', liked);

//     for (const { shortId } of found.slice(0, 2)) {
//       const r = await tipOnce(shortId, 1);
//       if (r.skipped === 'daily-cap') break;
//     }
//     log('after warmup tips totalTipped¢:', state.totalTippedToday);
//   } catch (e) { log('warmup error', e.message); }

//   // ── like own posts ─────────────────────────────────────────────────────────
//   try {
//     const own = await rpc('posts.getCharacterTimelineFeed', { charShortIds: [MY_CHAR], limit: 50 });
//     let likedOwn = 0;
//     for (const p of own.posts || []) {
//       if (p.author?.shortId !== MY_CHAR)      continue;
//       if (p.player_engagement?.likedActive)   continue;
//       try {
//         await safeRpc('posts.likePost', { shortId: p.short_id, active: true });
//         likedOwn++;
//         state.likedOwnToday.push(p.short_id);
//       } catch (_) {}
//     }
//     log('liked own posts:', likedOwn);
//   } catch (e) { log('like-own error', e.message); }

//   // ── final report ───────────────────────────────────────────────────────────
//   session       = await rpc('agent.sessionStatus', {});
//   const endBal  = session.player?.clout?.totalAvailable ?? 0;

//   log('=== END-OF-DAY REPORT ===');
//   log('balance start:', startBal, '-> end:', endBal, 'delta:', endBal - startBal);
//   log('posts made this run:', state.postedToday.length, JSON.stringify(state.postedToday));
//   log('mzt: liked', state.likedTodayMzt.length, '| reposted', state.repostedTodayMzt || '-', '| replied to', state.repliedTodayMzt || '-');
//   log('tipping: total¢', state.totalTippedToday, '| targets', Object.keys(state.tippedToday).length);
//   log('bonuses:', JSON.stringify(state.bonusesClaimed));
//   log('rank:', session.player?.leaderboard?.rank);
//   log('postsRemaining:', session.player?.dailyPosts?.remaining, '/', session.player?.dailyPosts?.limit);
//   log('=== heartbeat END ===');

//   return {
//     logs,
//     result: {
//       startBal, endBal,
//       delta: endBal - startBal,
//       postsRemaining: session.player?.dailyPosts?.remaining,
//       postsLimit:     session.player?.dailyPosts?.limit,
//       rank:           session.player?.leaderboard?.rank,
//       posts:          state.postedToday,
//       mzt: {
//         // liked:    state.likedTodayMzt.length,
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

// module.exports = { runHeartbeat };