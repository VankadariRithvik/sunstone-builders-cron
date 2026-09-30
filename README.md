# sunstone-builders-cron

Scheduled triggers for the Sunstone Builders backend on Render. Each job
only POSTs to one endpoint with `CRON_SECRET` (repo secret, same value as
Render → Environment); all real work happens on the server.

- `github-activity-sync.yml`: daily 03:00 IST, GitHub/LeetCode/Codeforces activity
- `weekly-leaderboard.yml`: 10:00, 17:00, 23:30 IST, weekly leaderboard

Copies of the same workflows live in `aarushmishra/sunstone-builders`. Keep
only one set running, or jobs run twice.
