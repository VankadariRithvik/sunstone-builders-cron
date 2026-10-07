// Drives one weekly-leaderboard run as many short calls instead of one long
// request (api/cron/weekly-leaderboard.ts in sunstone-builders, ?phase=…).
//
//   start → coding batches → github batches → finish
//
// Each call is retried on its own (network drop, 5xx, ok:false), so a Render
// restart or deploy mid-run costs one small batch, not the whole run, and no
// failure email. The job only fails if one call keeps failing.
// A quick GET ?phase=ping first checks that the API supports the batched
// mode; an older API (405) gets the original single request instead, exactly
// as before (one attempt, long timeout), so a full run is never started twice.
//
// Env: CRON_SECRET (required), LEADERBOARD_URL (optional, defaults to prod).

const URL_BASE = process.env.LEADERBOARD_URL || 'https://sunstone-builders.onrender.com/api/cron/weekly-leaderboard';
const SECRET = process.env.CRON_SECRET;
if (!SECRET) {
  console.error('CRON_SECRET is not set');
  process.exit(1);
}

const CALL_TIMEOUT_MS = 5 * 60_000; // one batch should take ~1–2 min
const RETRY_DELAYS_MS = [20_000, 60_000, 180_000]; // waits before attempts 2, 3, 4
const MAX_CALLS = 2000; // runaway guard
const LIMITS = { coding: process.env.CODING_LIMIT, github: process.env.GITHUB_LIMIT };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (msg, extra) => console.log(`${new Date().toISOString()} ${msg}${extra ? ' ' + JSON.stringify(extra) : ''}`);

const LEGACY_TIMEOUT_MS = 45 * 60_000;

async function post(params, timeoutMs = CALL_TIMEOUT_MS, method = 'POST') {
  const url = new URL(URL_BASE);
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method,
      headers: { Authorization: `Bearer ${SECRET}`, 'Content-Type': 'application/json' },
      body: method === 'POST' ? '{}' : undefined,
      signal: ctrl.signal,
    });
    const text = await res.text();
    let body = null;
    try {
      body = JSON.parse(text);
    } catch {
      /* not JSON (proxy error page) */
    }
    return { status: res.status, body, text: text.slice(0, 300) };
  } finally {
    clearTimeout(timer);
  }
}

/** One call with retries. Returns the JSON body of the first ok:true answer, or throws after the last attempt. */
async function call(params, label) {
  let last = '';
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    if (attempt > 0) {
      log(`retrying ${label} in ${RETRY_DELAYS_MS[attempt - 1] / 1000}s`, { last });
      await sleep(RETRY_DELAYS_MS[attempt - 1]);
    }
    try {
      const r = await post(params);
      if (r.body?.ok === true) return r.body;
      // A 4xx that isn't rate limiting won't get better on retry.
      if (r.status >= 400 && r.status < 500 && r.status !== 429) {
        const err = new Error(`${label}: HTTP ${r.status} ${r.body?.errorMessage ?? r.text}`);
        err.permanent = true;
        throw err;
      }
      last = `HTTP ${r.status} ${r.body?.errorMessage ?? r.text}`;
    } catch (err) {
      if (err.permanent) throw err;
      last = err.name === 'AbortError' ? 'timed out' : String(err.message || err);
    }
  }
  throw new Error(`${label} failed after ${RETRY_DELAYS_MS.length + 1} attempts: ${last}`);
}

/** The original all-in-one request: one attempt, long timeout (a retry would start a second full run). */
async function runLegacy(reason) {
  log(`using the single-request run (${reason})`);
  const r = await post({}, LEGACY_TIMEOUT_MS);
  if (r.body?.ok !== true) throw new Error(`single-request run failed: HTTP ${r.status} ${r.body?.errorMessage ?? r.text}`);
  log('single-request run done', r.body.report);
}

/** Does the API support ?phase=…? Older APIs answer GET with 405. Probe failures are retried like any call. */
async function batchedSupported() {
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    if (attempt > 0) await sleep(RETRY_DELAYS_MS[attempt - 1]);
    try {
      const r = await post({ phase: 'ping' }, 60_000, 'GET');
      if (r.body?.ok === true && r.body?.batched === true) return true;
      if (r.status === 405 || r.status === 404) return false;
    } catch {
      /* network drop: retry */
    }
  }
  throw new Error('API did not answer the batched-mode check');
}

async function main() {
  if (!(await batchedSupported())) {
    await runLegacy('API has no batched mode yet');
    return;
  }
  const start = await call({ phase: 'start' }, 'start');
  const runId = start.run_id;
  if (!runId || !start.next) throw new Error('start answered without a run id');
  log(`run ${runId} started`, start.report);

  let step = start.next;
  const totals = { coding: 0, github: 0 };
  for (let n = 0; step && n < MAX_CALLS; n++) {
    const label = `${step.phase}${step.cursor ? ' after ' + step.cursor.slice(0, 8) : ''}`;
    const body = await call({ phase: step.phase, run_id: runId, cursor: step.cursor, limit: LIMITS[step.phase] }, label);
    if (step.phase === 'coding' || step.phase === 'github') {
      totals[step.phase] += body.processed ?? 0;
      log(`${label}: ${body.processed} students, ${body.staged} rows`);
    } else {
      log(`${step.phase} done`, body.report);
    }
    step = body.next;
  }
  if (step) throw new Error(`run ${runId} stopped after ${MAX_CALLS} calls without finishing`);
  log(`run ${runId} complete`, totals);
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
