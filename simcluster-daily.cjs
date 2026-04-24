#!/usr/bin/env node
/**
 * Simcluster daily heartbeat for @HallenjayArt — Render Cron Job edition.
 * Runs the full daily strategy in one shot. Idempotent: safe to run multiple
 * times per day (Simcluster server enforces post / tip caps).
 *
 * REQUIRED ENV: SIMCLUSTER_BEARER  (the 46-char bearer token)
 *
 * Schedule on Render (UTC): 15 9 * * *   (= 09:15 UTC daily)
 */

require("dotenv").config();

const TOKEN = process.env.SIMCLUSTER_BEARER;
if (!TOKEN || TOKEN.length < 30) {
  console.error('FATAL: SIMCLUSTER_BEARER env var missing or too short (got ' + (TOKEN ? TOKEN.length : 0) + ' chars). Need ~46-char bearer token.');
  process.exit(1);
}

const today = new Date().toISOString().slice(0, 10);

// --- strategy constants ---
const FPNAP        = 'eNXWgYAn';   // For Profit Not A Priest concept
const FPNAP_BOUNTY = '8YzY7lmx';
const MZT_CHAR     = '6E4nRNo3';   // @mztacat character
const MY_CHAR      = 'lBOaqwV2';   // @HallenjayArt
const TIP_DAILY_CAP = 50;          // total tips per day (¢)
const MIN_MEDIA_POSTS = 2;         // at least 2 of 5 with media

// --- log helper ---
function log(...a) {
  console.log(`[${new Date().toISOString()}] ` + a.map(x => typeof x === 'string' ? x : JSON.stringify(x)).join(' '));
}
process.on('uncaughtException', (e) => { log('FATAL', e.message, e.stack); process.exit(1); });

// --- MCP RPC ---
let _rpcId = 1;
async function rpc(name, args = {}) {
  const id = _rpcId++;
  const r = await fetch('https://simcluster.ai/mcp', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + TOKEN,
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream'
    },
    body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } })
  });
  const j = await r.json();
  if (j.result?.isError) throw new Error(`${name}: ${j.result.content?.[0]?.text || 'unknown'}`);
  if (j.error) throw new Error(`${name}: ${j.error.message}`);
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

// --- in-memory daily counters (reset each cron run) ---
const state = {
  day: today,
  tippedToday: {},
  totalTippedToday: 0,
  likedTodayMzt: [],
  repostedTodayMzt: null,
  repliedTodayMzt: null,
  postedToday: [],
  bonusesClaimed: {},
  likedOwnToday: []
};

async function tipOnce(shortId, amount = 1) {
  if (state.tippedToday[shortId]) return { skipped: 'already-tipped-this-run' };
  if (state.totalTippedToday + amount > TIP_DAILY_CAP) return { skipped: 'daily-cap' };
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
      log('SIGN-IN bonus: claim endpoint not exposed via MCP; browser claim required.');
      state.bonusesClaimed.signIn = 'browser-required';
    } else {
      state.bonusesClaimed.signIn = 'locked-already-claimed';
      log('SIGN-IN already claimed (locked until', st.nextClaimLockedUntil, ')');
    }
  } catch (e) { state.bonusesClaimed.signIn = 'error:' + e.message; }
  try {
    const bb = await rpc('bounties.checkDailyBillboardProgress', {});
    state.bonusesClaimed.billboard = `progress ${bb.extras?.progressCount ?? 0}/${bb.extras?.progressTarget ?? 1}`;
  } catch (e) { state.bonusesClaimed.billboard = 'error:' + e.message; }
}

async function fetchMzt() {
  const t = await rpc('posts.getCharacterTimelineFeed', { charShortIds: [MZT_CHAR], limit: 30 });
  return (t.posts || []).filter(p => p.author?.username === 'mztacat' && p.author?.shortId === MZT_CHAR);
}

async function generateImage() {
  log('Generating image with FPNAP …');
  const k = await rpc('create.image', { conceptShortIds: [FPNAP], items: [{ type: 'concept', shortId: FPNAP }], aspectRatio: '1:1' });
  const evtId = k.generation_event_id;
  if (!evtId) throw new Error('no generation_event_id: ' + JSON.stringify(k));
  for (let i = 0; i < 60; i++) {
    await sleep(3000);
    const st = await rpc('create.getGenerationStatus', { generation_event_id: evtId });
    if (st.status === 'complete' || st.status === 'completed') return st;
    if (st.status === 'failed' || st.status === 'error') throw new Error('image gen failed: ' + JSON.stringify(st));
  }
  throw new Error('image gen timed out');
}

async function makePostText() {
  return await rpc('create.text', { conceptShortIds: [FPNAP], items: [{ type: 'concept', shortId: FPNAP }], mediaShortIds: [], bountyShortId: FPNAP_BOUNTY });
}
async function makePostTextWithMedia(mediaShortId) {
  return await rpc('create.text', {
    conceptShortIds: [FPNAP],
    items: [{ type: 'concept', shortId: FPNAP }, { type: 'artifact', shortId: mediaShortId, artifactType: 'image' }],
    mediaShortIds: [mediaShortId], bountyShortId: FPNAP_BOUNTY
  });
}
async function publishPost(textShortId, mediaShortIds = []) {
  return await rpc('create.post', { textCompletionShortId: textShortId, mediaShortIds });
}
async function replyToMzt(replyToShortId) {
  const c = await rpc('create.replyCompletion', { replyToShortId, conceptShortIds: [FPNAP] });
  return await rpc('create.createPostReply', { replyToShortId, textCompletionShortId: c.shortId });
}

// --- main ---
(async () => {
  log('=== Simcluster daily heartbeat START ===', 'day=' + today);

  await tryClaimBonuses();

  let session = await rpc('agent.sessionStatus', {});
  const startBal = session.player?.clout?.totalAvailable ?? 0;
  let postsLeft = session.player?.dailyPosts?.remaining ?? 0;
  log('START balance:', startBal, 'postsRemaining:', postsLeft);

  // mzt engagement
  const mztPosts = await fetchMzt();
  log('mztacat posts seen:', mztPosts.length);
  for (const p of mztPosts) {
    if (p.player_engagement?.likedActive) continue;
    try { await safeRpc('posts.likePost', { shortId: p.short_id, active: true }); state.likedTodayMzt.push(p.short_id); }
    catch (e) { log('like-mzt error', p.short_id, e.message); }
  }
  log('mzt liked this run:', state.likedTodayMzt.length);

  // repost best
  const repostable = mztPosts.filter(p => !p.player_engagement?.repostedActive)
    .sort((a, b) => (b.cumulative_tips || 0) - (a.cumulative_tips || 0));
  if (repostable[0]) {
    try { await safeRpc('posts.repostPost', { shortId: repostable[0].short_id, active: true });
          state.repostedTodayMzt = repostable[0].short_id;
          log('reposted mzt best:', repostable[0].short_id);
    } catch (e) { log('repost error', e.message); }
  }

  // tip mzt 1c each
  for (const p of mztPosts) {
    const r = await tipOnce(p.short_id, 1);
    if (r.skipped === 'daily-cap') { log('tip cap reached'); break; }
  }
  log('after mzt tips totalTipped¢:', state.totalTippedToday);

  // refresh quota
  session = await rpc('agent.sessionStatus', {});
  postsLeft = session.player?.dailyPosts?.remaining ?? 0;
  let bal = session.player?.clout?.totalAvailable ?? 0;
  log('postsLeft after engagement:', postsLeft, 'balance:', bal);

  // reply slot
  if (postsLeft > 0 && bal >= 10) {
    const latestTop = mztPosts.find(p => !p.in_reply_to);
    if (latestTop) {
      try {
        const reply = await replyToMzt(latestTop.short_id);
        const sid = reply.post?.short_id || reply.newPost?.short_id;
        state.repliedTodayMzt = latestTop.short_id;
        state.postedToday.push({ shortId: sid, kind: 'reply-to-mzt', target: latestTop.short_id });
        log('replied to mzt latest', latestTop.short_id, '->', sid);
        postsLeft--;
      } catch (e) { log('reply error', e.message); }
    }
  }

  // remaining post slots: 2 with media, rest text
  const slotsToFill = postsLeft;
  const mediaSlots = Math.min(MIN_MEDIA_POSTS, slotsToFill);
  log('filling slots:', slotsToFill, 'mediaSlots:', mediaSlots);
  for (let i = 0; i < slotsToFill; i++) {
    session = await rpc('agent.sessionStatus', {});
    bal = session.player?.clout?.totalAvailable ?? 0;
    if (bal < 20) { log('balance below 20¢, stopping. bal=', bal); break; }
    const wantMedia = i < mediaSlots;
    try {
      let mediaShortId = null;
      if (wantMedia) {
        const img = await generateImage();
        mediaShortId = img.media?.shortId || img.shortId || img.media_shortId || img.image?.shortId || img.media?.short_id;
        if (!mediaShortId) log('no media shortId, falling back to text. raw:', JSON.stringify(img).slice(0, 300));
      }
      const textRes = mediaShortId ? await makePostTextWithMedia(mediaShortId) : await makePostText();
      const pub = await publishPost(textRes.shortId, mediaShortId ? [mediaShortId] : []);
      const sid = pub.newPost?.short_id || pub.post?.short_id;
      state.postedToday.push({ shortId: sid, kind: mediaShortId ? 'image' : 'text', media: mediaShortId });
      log('posted slot', i + 1, '->', sid, mediaShortId ? '(with image)' : '(text)');
    } catch (e) {
      log('post slot', i + 1, 'error:', e.message);
      if (/cap|limit|exceeded/i.test(e.message)) break;
    }
  }

  // warmup
  try {
    const feed = await rpc('agent.readFeed', { kind: 'recent', limit: 25 });
    const re = /^shortId:\s*(\S+)[\s\S]*?^author:.*?@(\S+)/gm;
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

  // like own posts
  try {
    const own = await rpc('posts.getCharacterTimelineFeed', { charShortIds: [MY_CHAR], limit: 50 });
    let likedOwn = 0;
    for (const p of own.posts || []) {
      if (p.author?.shortId !== MY_CHAR) continue;
      if (p.player_engagement?.likedActive) continue;
      try { await safeRpc('posts.likePost', { shortId: p.short_id, active: true }); likedOwn++; state.likedOwnToday.push(p.short_id); }
      catch (_) {}
    }
    log('liked own posts:', likedOwn);
  } catch (e) { log('like-own error', e.message); }

  // final report
  session = await rpc('agent.sessionStatus', {});
  const endBal = session.player?.clout?.totalAvailable ?? 0;
  log('=== END-OF-DAY REPORT ===');
  log('balance start:', startBal, '-> end:', endBal, 'delta:', endBal - startBal);
  log('posts made this run:', state.postedToday.length, JSON.stringify(state.postedToday));
  log('mzt: liked', state.likedTodayMzt.length, '| reposted', state.repostedTodayMzt || '-', '| replied to', state.repliedTodayMzt || '-');
  log('tipping: total¢', state.totalTippedToday, '| targets', Object.keys(state.tippedToday).length);
  log('bonuses:', JSON.stringify(state.bonusesClaimed));
  log('rank:', session.player?.leaderboard?.rank);
  log('postsRemaining:', session.player?.dailyPosts?.remaining, '/', session.player?.dailyPosts?.limit);
  log('=== heartbeat END ===');
})().catch(e => { log('FATAL', e.message, e.stack); process.exit(1); });
