// Converts queued uploaded slide decks to PDF (see .github/workflows/convert-decks.yml).
// For each project_artifacts row with convert_status = 'pending': download the
// file, `soffice --headless --convert-to pdf`, upload the PDF next to it in the
// public project-artifacts bucket, then set pdf_url + convert_status = 'done'
// (or 'failed' + convert_error). No dependencies beyond Node 22's fetch.
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, posix } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const URL_BASE = process.env.SUPABASE_URL?.replace(/\/$/, '');
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const BUCKET = 'project-artifacts';
const BATCH = 20;
const BUDGET_MS = 20 * 60_000;
const MAX_BYTES = 60 * 1024 * 1024;

if (!URL_BASE || !KEY) {
  console.error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required');
  process.exit(1);
}

const headers = { apikey: KEY, Authorization: `Bearer ${KEY}` };

async function rest(path, init = {}) {
  const res = await fetch(`${URL_BASE}/rest/v1/${path}`, {
    ...init,
    headers: { ...headers, 'Content-Type': 'application/json', ...(init.headers ?? {}) },
  });
  if (!res.ok) throw new Error(`REST ${path} -> ${res.status} ${await res.text()}`);
  return res.status === 204 ? null : res.json();
}

async function setRow(id, patch) {
  await rest(`project_artifacts?id=eq.${id}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify(patch),
  });
}

async function convertOne(row) {
  const dir = await mkdtemp(join(tmpdir(), 'deck-'));
  try {
    const ext = (row.storage_path.match(/\.([a-z0-9]+)$/i)?.[1] ?? 'pptx').toLowerCase();
    const input = join(dir, `deck.${ext}`);
    const res = await fetch(`${URL_BASE}/storage/v1/object/${BUCKET}/${row.storage_path.split('/').map(encodeURIComponent).join('/')}`, { headers });
    if (!res.ok) throw new Error(`download ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_BYTES) throw new Error(`file too large (${Math.round(buf.length / 1e6)}MB)`);
    await writeFile(input, buf);

    await run('soffice', ['--headless', '--norestore', '--convert-to', 'pdf', '--outdir', dir, input], { timeout: 180_000 });
    const pdf = await readFile(join(dir, 'deck.pdf'));
    if (pdf.length < 500) throw new Error('converter produced an empty PDF');

    const folder = posix.dirname(row.storage_path);
    const pdfPath = `${folder === '.' ? '' : folder + '/'}${row.id}-v${Date.now()}.pdf`;
    const up = await fetch(`${URL_BASE}/storage/v1/object/${BUCKET}/${pdfPath}`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/pdf', 'x-upsert': 'true' },
      body: pdf,
    });
    if (!up.ok) throw new Error(`upload ${up.status} ${await up.text()}`);
    const pdfUrl = `${URL_BASE}/storage/v1/object/public/${BUCKET}/${pdfPath}`;

    await setRow(row.id, { pdf_url: pdfUrl, convert_status: 'done', convert_error: null, converted_at: new Date().toISOString() });
    console.log(`done ${row.id} -> ${pdfPath} (${Math.round(pdf.length / 1024)} KB)`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const started = Date.now();
let done = 0;
let failed = 0;
const tried = new Set();
while (Date.now() - started < BUDGET_MS) {
  const rows = await rest(
    `project_artifacts?select=id,storage_path&convert_status=eq.pending&storage_path=not.is.null&order=created_at.desc&limit=${BATCH}`,
  );
  const todo = rows.filter((r) => !tried.has(r.id));
  if (todo.length === 0) break;
  for (const row of todo) {
    tried.add(row.id);
    try {
      await convertOne(row);
      done++;
    } catch (err) {
      failed++;
      const msg = String(err?.stderr || err?.message || err).slice(0, 500);
      console.error(`failed ${row.id}: ${msg}`);
      await setRow(row.id, { convert_status: 'failed', convert_error: msg }).catch((e) => console.error('could not mark failed', e));
    }
    if (Date.now() - started > BUDGET_MS) break;
  }
}
console.log(`converted ${done}, failed ${failed}, ${Math.round((Date.now() - started) / 1000)}s`);
