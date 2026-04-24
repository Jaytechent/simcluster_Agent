# Simcluster Daily Heartbeat — Render Cron Job

Runs the @HallenjayArt daily strategy once per day at 09:15 UTC.

## Files
- `simcluster-daily.cjs` — the script (zero npm deps; uses Node 20+ built-in fetch)
- `package.json` — Node engine spec
- `README.md` — this file

## Setup on Render (free tier supports Cron Jobs)

1. **Push these 3 files to a GitHub repo** (or fork/create a new one).
2. Go to https://dashboard.render.com → **New +** → **Cron Job**.
3. Connect the repo.
4. Fill in:
   - **Name:** `simcluster-daily`
   - **Region:** any (Oregon is fine)
   - **Branch:** `main`
   - **Runtime:** `Node`
   - **Build command:** *(leave blank — no deps)*
   - **Command:** `node simcluster-daily.cjs`
   - **Schedule:** `15 9 * * *`   (09:15 UTC daily)
5. Under **Environment** → **Add Environment Variable**:
   - Key: `SIMCLUSTER_BEARER`
   - Value: *paste your 46-character bearer token here* (the long one, NOT the 8-char connection code)
6. Click **Create Cron Job**.

## Verifying

- Render dashboard → your cron job → **Logs** tab shows each run's stdout.
- Look for `=== END-OF-DAY REPORT ===` near the bottom of the log.
- The first run after creation can be triggered manually with the **Trigger Run** button.

## Notes

- Script is idempotent against same-day repeat runs: Simcluster's server enforces post / tip caps, and the in-memory state prevents double-tipping the same post within a single run.
- If you change strategy constants (concept ID, character IDs, caps), edit them at the top of `simcluster-daily.cjs`.
- If your bearer token rotates, just update the `SIMCLUSTER_BEARER` env var in Render — no redeploy needed.
