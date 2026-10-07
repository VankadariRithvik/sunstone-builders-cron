// One-time shrink of oversized avatars (and covers) in Supabase Storage.
// For each object: download → shrink (scripts/shrink-lib.mjs) → if ≥10% smaller,
// copy the original to backup-originals/<path> in the same bucket (skipped if a
// backup already exists), then overwrite the object at the SAME path with the
// same content-type, so no database URL changes. Logs one JSON line per file.
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
// Args (via env): DRY_RUN=1 (default) | 0, LIMIT=<n> (default 10), KIND=avatar|cover|all (default avatar),
//                 MIN_BYTES=<n> only touch files bigger than this (default 150000)
import { shrink } from './shrink-lib.mjs';

const URL_ = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const DRY = process.env.DRY_RUN !== '0';
const LIMIT = Number(process.env.LIMIT ?? 10);
const KIND = process.env.KIND ?? 'avatar';
const MIN_BYTES = Number(process.env.MIN_BYTES ?? 150000);
const H = { apikey: KEY, Authorization: `Bearer ${KEY}` };
const OBJ = '/storage/v1/object/public/';

async function rows(table, col) {
  const r = await fetch(`${URL_}/rest/v1/${table}?select=${col}&${col}=like.*${encodeURIComponent(OBJ)}*`, { headers: H });
  if (!r.ok) throw new Error(`${table}: ${r.status}`);
  return (await r.json()).map((x) => x[col].split('?')[0]);
}

function parse(u) {
  const rest = u.slice(u.indexOf(OBJ) + OBJ.length); // bucket/path
  const i = rest.indexOf('/');
  return { bucket: rest.slice(0, i), path: decodeURIComponent(rest.slice(i + 1)) };
}

async function exists(bucket, path) {
  const r = await fetch(`${URL_}/storage/v1/object/info/${bucket}/${encodeURI(path)}`, { headers: H });
  return r.ok;
}

async function upload(bucket, path, body, type, upsert) {
  const r = await fetch(`${URL_}/storage/v1/object/${bucket}/${encodeURI(path)}`, {
    method: upsert ? 'PUT' : 'POST',
    headers: { ...H, 'Content-Type': type, 'Cache-Control': '3600', 'x-upsert': upsert ? 'true' : 'false' },
    body,
  });
  if (!r.ok) throw new Error(`upload ${bucket}/${path}: ${r.status} ${await r.text()}`);
}

const kinds = KIND === 'all' ? ['avatar', 'cover'] : [KIND];
const urls = [];
for (const k of kinds) {
  const list = k === 'avatar' ? await rows('profiles', 'avatar_url') : await rows('projects', 'cover_url');
  for (const u of new Set(list)) urls.push({ kind: k, url: u });
}

let done = 0, saved = 0, seen = 0, beforeAll = 0, afterAll = 0;
const skips = {};
const skip = (why) => (skips[why] = (skips[why] ?? 0) + 1);
for (const { kind, url } of urls) {
  if (done >= LIMIT) break;
  const { bucket, path } = parse(url);
  if (path.startsWith('backup-originals/')) continue;
  seen++;
  try {
    const res = await fetch(url);
    if (!res.ok) { skip(`fetch ${res.status}`); console.log(JSON.stringify({ url, skip: `fetch ${res.status}` })); continue; }
    const type = res.headers.get('content-type') ?? 'application/octet-stream';
    const buf = Buffer.from(await res.arrayBuffer());
    beforeAll += buf.length;
    if (buf.length < MIN_BYTES) { skip('under min_bytes'); afterAll += buf.length; continue; }
    const r = await shrink(buf, kind);
    if (!r.data) { skip(r.skipped); afterAll += buf.length; console.log(JSON.stringify({ bucket, path, before: buf.length, skip: r.skipped })); continue; }
    const line = { bucket, path, type, before: buf.length, after: r.data.length, px: `${r.meta.width}x${r.meta.height}->${r.info.width}x${r.info.height}`, dry: DRY };
    if (!DRY) {
      const backup = `backup-originals/${path}`;
      if (!(await exists(bucket, backup))) await upload(bucket, backup, buf, type, false);
      await upload(bucket, path, r.data, type, true);
    }
    console.log(JSON.stringify(line));
    done++; saved += buf.length - r.data.length; afterAll += r.data.length;
  } catch (e) {
    skip('error');
    console.log(JSON.stringify({ url, error: String(e) }));
  }
}
console.log(JSON.stringify({ summary: { seen, processed: done, skipped: skips, beforeMB: +(beforeAll / 1e6).toFixed(1), afterMB: +(afterAll / 1e6).toFixed(1), savedMB: +(saved / 1e6).toFixed(1), dryRun: DRY } }));
