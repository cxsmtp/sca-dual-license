#!/usr/bin/env node
/**
 * cx-sca-web.mjs — browser UI for the Checkmarx One SCA multi-license finder.
 *
 *   node cx-sca-web.mjs            (then open http://localhost:3939)
 *
 * Paste your Checkmarx One API key into the page. The tenant and region are
 * detected from the key. The page lists every package with more than one
 * effective license across the last N projects and exports it to CSV.
 *
 * Checkmarx One does not allow direct browser calls (no CORS), so this small
 * server, bound to 127.0.0.1 only, makes the API calls for the page. The API key
 * is kept in memory for the duration of one run and is never written to disk.
 */

import http from 'node:http';
import { randomUUID } from 'node:crypto';
import {
  resolveConfig, CxClient, getLatestScaScanPerProject, fetchScaReport,
  analyseReport, toRows, mapLimit, toCsv,
} from './cx-sca-multi-license.mjs';

const PORT = Number(process.env.PORT) || 3939;
const jobs = new Map();

function startJob({ apiKey, projects = 50, minLicenses = 2, allLicenses = false, branch = '', concurrency = 4 }) {
  const cfg = resolveConfig({ CX_API_KEY: String(apiKey || '').trim() }); // throws on a bad key
  const job = {
    id: randomUUID(), status: 'running', tenant: cfg.tenant, baseUrl: cfg.baseUrl,
    log: [], rows: [], total: 0, done: 0, failures: [], projectsWithHits: 0,
    minLicenses, startedAt: new Date().toISOString(),
  };
  jobs.set(job.id, job);
  const say = (m) => job.log.push(`${new Date().toLocaleTimeString()}  ${m}`);

  (async () => {
    const client = new CxClient(cfg);
    await client.authenticate();
    say(`Signed in to tenant "${cfg.tenant}" (${cfg.baseUrl})`);
    say(`Finding the last ${projects} projects with a completed SCA scan...`);
    const scans = await getLatestScaScanPerProject(client, projects, branch || null);
    job.total = scans.length;
    say(`Found ${scans.length} project(s). Exporting SCA reports...`);

    await mapLimit(scans, concurrency, async (scan) => {
      try {
        const report = await fetchScaReport(client, scan.id, !allLicenses);
        const hits = toRows(scan, analyseReport(report, { allLicenses }), minLicenses);
        job.rows.push(...hits);
        if (hits.length) job.projectsWithHits++;
        say(`${scan.projectName}: ${hits.length} multi-license package(s)`);
      } catch (err) {
        job.failures.push({ project: scan.projectName, scanId: scan.id, error: err.message });
        say(`${scan.projectName}: FAILED - ${err.message}`);
      } finally {
        job.done++;
      }
    });
    job.rows.sort((a, b) => a.project.localeCompare(b.project) || b.licenseCount - a.licenseCount || a.package.localeCompare(b.package));
    job.status = 'done';
    say(`Finished: ${job.rows.length} package row(s) in ${job.projectsWithHits} project(s).`);
  })().catch((err) => {
    job.status = 'error';
    job.error = err.message;
    say(`ERROR: ${err.message}`);
  });

  return job;
}

const readBody = (req) => new Promise((resolve, reject) => {
  let data = '';
  req.on('data', (c) => { data += c; if (data.length > 1e6) req.destroy(); });
  req.on('end', () => { try { resolve(JSON.parse(data || '{}')); } catch (e) { reject(e); } });
  req.on('error', reject);
});

const send = (res, code, body, type = 'application/json') => {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  // Only accept requests addressed to this local server (blocks DNS-rebinding tricks).
  if (!/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(req.headers.host || '')) return send(res, 403, { error: 'forbidden' });

  try {
    if (req.method === 'GET' && url.pathname === '/') return send(res, 200, PAGE, 'text/html; charset=utf-8');

    if (req.method === 'POST' && url.pathname === '/api/run') {
      const job = startJob(await readBody(req));
      return send(res, 200, { jobId: job.id, tenant: job.tenant, baseUrl: job.baseUrl });
    }

    const m = url.pathname.match(/^\/api\/job\/([\w-]+)(\.csv)?$/);
    if (req.method === 'GET' && m) {
      const job = jobs.get(m[1]);
      if (!job) return send(res, 404, { error: 'unknown job' });
      if (m[2]) {
        res.setHeader('Content-Disposition', 'attachment; filename="multi-license-report.csv"');
        return send(res, 200, toCsv(job.rows), 'text/csv; charset=utf-8');
      }
      return send(res, 200, job);
    }
    send(res, 404, { error: 'not found' });
  } catch (err) {
    send(res, 400, { error: err.message });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Checkmarx One multi-license finder running at http://localhost:${PORT}`);
  console.log('Open that address in your browser and paste your API key there. Ctrl+C to stop.');
});

// ------------------------------------------------------------------ Page --

const PAGE = /* html */ `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>SCA Multi-License Finder</title>
<style>
  :root { --bg:#f6f7f9; --card:#fff; --text:#1c2330; --muted:#5d6878; --line:#dfe3e8; --accent:#2457d6; --warn:#b3261e; --chip:#eef2fb; }
  @media (prefers-color-scheme: dark) { :root { --bg:#12151b; --card:#1b2029; --text:#e6e9ee; --muted:#9aa4b2; --line:#2c333f; --accent:#7aa2ff; --warn:#ff8a80; --chip:#232b3a; } }
  * { box-sizing: border-box; }
  body { margin:0; font:14px/1.45 system-ui, -apple-system, Segoe UI, Roboto, sans-serif; background:var(--bg); color:var(--text); }
  main { max-width:1200px; margin:0 auto; padding:24px 16px 48px; }
  h1 { font-size:22px; margin:0 0 4px; }
  p.sub { color:var(--muted); margin:0 0 20px; }
  .card { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:16px; margin-bottom:16px; }
  label { display:block; font-weight:600; margin-bottom:4px; }
  input, select { font:inherit; color:inherit; background:var(--bg); border:1px solid var(--line); border-radius:6px; padding:8px 10px; width:100%; }
  .grid { display:grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap:12px; margin-top:12px; }
  .hint { color:var(--muted); font-size:12px; margin-top:4px; min-height:1em; }
  .hint.bad { color:var(--warn); }
  button { font:inherit; font-weight:600; border:0; border-radius:6px; padding:9px 16px; cursor:pointer; background:var(--accent); color:#fff; }
  button.secondary { background:transparent; color:var(--accent); border:1px solid var(--accent); }
  button:disabled { opacity:.5; cursor:default; }
  .row { display:flex; gap:12px; align-items:center; flex-wrap:wrap; }
  .bar { height:6px; background:var(--line); border-radius:3px; overflow:hidden; flex:1; min-width:120px; }
  .bar > div { height:100%; width:0; background:var(--accent); transition:width .3s; }
  pre { max-height:160px; overflow:auto; background:var(--bg); border-radius:6px; padding:8px; font-size:12px; margin:12px 0 0; white-space:pre-wrap; }
  .stats { display:flex; gap:24px; flex-wrap:wrap; margin-bottom:12px; }
  .stat b { display:block; font-size:22px; }
  .stat span { color:var(--muted); font-size:12px; }
  .tablewrap { overflow-x:auto; }
  table { width:100%; border-collapse:collapse; }
  th, td { text-align:left; padding:8px; border-bottom:1px solid var(--line); vertical-align:top; }
  th { font-size:12px; color:var(--muted); text-transform:uppercase; letter-spacing:.03em; cursor:pointer; white-space:nowrap; }
  td.num { text-align:center; font-weight:700; }
  .chip { display:inline-block; background:var(--chip); border-radius:999px; padding:2px 8px; margin:2px 4px 2px 0; font-size:12px; white-space:nowrap; }
  .chip.High, .chip.Critical { color:var(--warn); }
  .empty { color:var(--muted); text-align:center; padding:24px; }
</style>
</head>
<body>
<main>
  <h1>SCA Multi-License Finder</h1>
  <p class="sub">Checkmarx One: packages with more than one effective OSS license across your most recently scanned projects.</p>

  <section class="card">
    <label for="key">Checkmarx One API key</label>
    <input id="key" type="password" autocomplete="off" spellcheck="false" placeholder="Paste your API key">
    <div id="detected" class="hint">Tenant and region are detected from the key.</div>
    <div class="grid">
      <div><label for="projects">Last N projects</label><input id="projects" type="number" min="1" value="50"></div>
      <div><label for="min">Min. effective licenses</label><input id="min" type="number" min="2" value="2"></div>
      <div><label for="branch">Branch (optional)</label><input id="branch" placeholder="any"></div>
      <div><label for="mode">Licenses to count</label>
        <select id="mode"><option value="eff">Effective only</option><option value="all">All declared</option></select></div>
    </div>
    <div class="row" style="margin-top:16px">
      <button id="run" disabled>Fetch results</button>
      <div class="bar"><div id="progress"></div></div>
      <span id="count" class="hint"></span>
    </div>
    <pre id="log" hidden></pre>
  </section>

  <section class="card" id="results" hidden>
    <div class="stats">
      <div class="stat"><b id="sProjects">0</b><span>projects analysed</span></div>
      <div class="stat"><b id="sHit">0</b><span>projects with multi-license packages</span></div>
      <div class="stat"><b id="sRows">0</b><span>packages listed</span></div>
      <div class="stat"><b id="sFail">0</b><span>failures</span></div>
    </div>
    <div class="row" style="margin-bottom:12px">
      <input id="filter" placeholder="Filter by project, package or license" style="flex:1;min-width:200px">
      <button id="csv" class="secondary">Export CSV</button>
    </div>
    <div class="tablewrap">
      <table>
        <thead><tr>
          <th data-k="project">Project</th><th data-k="package">Package</th><th data-k="version">Version</th>
          <th data-k="manager">Manager</th><th data-k="dependency">Dependency</th>
          <th data-k="licenseCount">#</th><th>Effective licenses</th>
        </tr></thead>
        <tbody id="tbody"></tbody>
      </table>
    </div>
  </section>
</main>
<script>
const $ = (id) => document.getElementById(id);
let rows = [], sortKey = 'project', sortDir = 1, jobId = null;

function decodeKey(k) {
  try {
    const p = JSON.parse(atob(k.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
    const m = (p.iss || '').match(/^(https?:\\/\\/[^/]+)\\/auth\\/realms\\/([^/]+)/);
    return m ? { iam: m[1], tenant: m[2], exp: p.exp } : null;
  } catch { return null; }
}

$('key').addEventListener('input', () => {
  const k = $('key').value.trim(), d = decodeKey(k), h = $('detected');
  if (!k) { h.textContent = 'Tenant and region are detected from the key.'; h.className = 'hint'; $('run').disabled = true; return; }
  if (!d) { h.textContent = 'This does not look like a Checkmarx One API key.'; h.className = 'hint bad'; $('run').disabled = true; return; }
  const host = new URL(d.iam).host.replace(/^([\\w-]+\\.)?iam\\./, (_, r) => (r || '') + 'ast.');
  const expired = d.exp && d.exp * 1000 < Date.now();
  h.textContent = 'Tenant: ' + d.tenant + '  ·  Region: ' + host + (expired ? '  ·  key has EXPIRED' : '');
  h.className = expired ? 'hint bad' : 'hint';
  $('run').disabled = !!expired;
});

$('run').addEventListener('click', async () => {
  $('run').disabled = true; $('log').hidden = false; $('log').textContent = 'Starting...';
  $('progress').style.width = '0'; $('results').hidden = true;
  try {
    const r = await fetch('/api/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
      apiKey: $('key').value.trim(), projects: +$('projects').value || 50, minLicenses: Math.max(2, +$('min').value || 2),
      branch: $('branch').value.trim(), allLicenses: $('mode').value === 'all' }) });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error);
    jobId = j.jobId; poll();
  } catch (e) { $('log').textContent = 'ERROR: ' + e.message; $('run').disabled = false; }
});

async function poll() {
  const job = await (await fetch('/api/job/' + jobId)).json();
  $('log').textContent = job.log.join('\\n'); $('log').scrollTop = 1e9;
  $('progress').style.width = job.total ? (100 * job.done / job.total) + '%' : '0';
  $('count').textContent = job.total ? job.done + ' / ' + job.total + ' projects' : '';
  rows = job.rows; render(job);
  if (job.status === 'running') setTimeout(poll, 1500); else $('run').disabled = false;
}

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function render(job) {
  $('results').hidden = false;
  if (job) {
    $('sProjects').textContent = job.done - job.failures.length; $('sHit').textContent = job.projectsWithHits;
    $('sRows').textContent = job.rows.length; $('sFail').textContent = job.failures.length;
  }
  const q = $('filter').value.toLowerCase();
  const list = rows.filter((r) => !q || [r.project, r.package, r.version, ...r.licenses].join(' ').toLowerCase().includes(q))
    .sort((a, b) => (a[sortKey] > b[sortKey] ? 1 : a[sortKey] < b[sortKey] ? -1 : 0) * sortDir);
  $('tbody').innerHTML = list.length ? list.map((r) => '<tr><td>' + esc(r.project) + '</td><td>' + esc(r.package) + '</td><td>' + esc(r.version) +
    '</td><td>' + esc(r.manager) + '</td><td>' + esc(r.dependency) + '</td><td class="num">' + r.licenseCount + '</td><td>' +
    r.riskLevels.map((x) => { const i = x.lastIndexOf(':'); const risk = x.slice(i + 1);
      return '<span class="chip ' + esc(risk) + '" title="Risk: ' + esc(risk) + '">' + esc(x.slice(0, i)) + '</span>'; }).join('') + '</td></tr>').join('')
    : '<tr><td colspan="7" class="empty">' + (rows.length ? 'No rows match the filter.' : 'No multi-license packages found yet.') + '</td></tr>';
}

$('filter').addEventListener('input', () => render());
document.querySelectorAll('th[data-k]').forEach((th) => th.addEventListener('click', () => {
  const k = th.dataset.k; sortDir = sortKey === k ? -sortDir : (k === 'licenseCount' ? -1 : 1); sortKey = k; render();
}));
$('csv').addEventListener('click', () => { if (jobId) location.href = '/api/job/' + jobId + '.csv'; });
</script>
</body>
</html>`;
