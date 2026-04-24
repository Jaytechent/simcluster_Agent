module.exports = function startScheduler(getToken) {
  const { runHeartbeat } = require('./heartbeat');

  console.log('Scheduler started...');

  async function job() {
    const token = getToken();

    if (!token) {
      console.log('No token yet, skipping...');
      return;
    }

    try {
      await runHeartbeat(token);
    } catch (e) {
      console.error('Heartbeat error:', e.message);
    }
  }

  // run immediately once
  job();

  // then every 24h
  setInterval(job, 24 * 60 * 60 * 1000);
};