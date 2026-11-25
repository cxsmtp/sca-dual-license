#!/usr/bin/env node
/**
 * cx-sca-multi-license.mjs
 *
 * Connects to a Checkmarx One tenant, takes the last N (default 50) projects
 * that have a completed SCA scan, pulls each scan's SCA report and lists every
 * package that carries MORE THAN ONE effective license (dual / multi-licensed).
 *
 * Results are printed as a list on the console and exported to CSV + JSON.
 *
 * Requirements: Node.js 18+ (uses built-in fetch). No npm dependencies.
 *
 * Auth (pick one):
 *   CX_API_KEY                       Checkmarx One API key (refresh token). Tenant,
 *                                    IAM URL and AST URL are derived from it.
 *   CX_CLIENT_ID + CX_CLIENT_SECRET  OAuth client (needs CX_TENANT + CX_BASE_URL).
 *
 * Optional env / overrides:
 *   CX_BASE_URL   e.g. https://ast.checkmarx.net, https://eu.ast.checkmarx.net
 *   CX_IAM_URL    e.g. https://iam.checkmarx.net (default: derived from CX_BASE_URL)
 *   CX_TENANT     tenant name
 *
 * Usage:
 *   node cx-sca-multi-license.mjs [options]
 *
 * Options:
 *   --projects <n>       Number of most recently scanned projects (default 50)
 *   --min-licenses <n>   Show packages with at least n effective licenses (default 2)
 *   --all-licenses       Count every declared license, not only effective ones
 *   --branch <name>      Only consider scans on this branch
 *   --out <prefix>       Output file prefix (default ./multi-license-report)
 *   --concurrency <n>    Parallel SCA exports (default 4)
 *   --from-file <path>   Analyse a local SCA "ScanReportJson" export instead of
 *                        calling the API (repeatable; handy for offline testing)
 *   --help
 */

import { writeFile, readFile } from 'node:fs/promises';
import { basename } from 'node:path';

// ---------------------------------------------------------------- CLI args --

function parseArgs(argv) {
  const opts = {
    projects: 50,
    minLicenses: 2,
    allLicenses: false,
    branch: null,
    out: './multi-license-report',
    concurrency: 4,
    fromFile: [],
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) die(`Missing value for ${a}`);
      return v;
    };
    switch (a) {
      case '--projects': opts.projects = toPosInt(next(), a); break;
      case '--min-licenses': opts.minLicenses = toPosInt(next(), a); break;
      case '--all-licenses': opts.allLicenses = true; break;
      case '--branch': opts.branch = next(); break;
      case '--out': opts.out = next(); break;
      case '--concurrency': opts.concurrency = toPosInt(next(), a); break;
      case '--from-file': opts.fromFile.push(next()); break;
      case '-h': case '--help': printHelp(); process.exit(0);
      default: die(`Unknown option: ${a} (see --help)`);
    }
  }
  return opts;
}

function toPosInt(v, flag) {
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n) || n < 1) die(`${flag} must be a positive integer`);
  return n;
}

function printHelp() {
  const src = process.argv[1] ? basename(process.argv[1]) : 'cx-sca-multi-license.mjs';
  console.log(`Usage: node ${src} [--projects 50] [--min-licenses 2] [--all-licenses]
       [--branch main] [--out ./multi-license-report] [--concurrency 4]
       [--from-file report.json ...]

Env: CX_API_KEY  (or CX_CLIENT_ID + CX_CLIENT_SECRET + CX_TENANT + CX_BASE_URL)
     CX_BASE_URL, CX_IAM_URL, CX_TENANT (optional overrides)`);
}

function die(msg) {
  console.error(`ERROR: ${msg}`);
  process.exit(1);
}

const log = (...a) => console.error(...a); // progress goes to stderr, results to stdout
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------- Auth/config --

function decodeJwtPayload(token) {
  try {
    const part = token.split('.')[1];
    return JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

function resolveConfig() {
  const env = process.env;
  const cfg = {
    apiKey: env.CX_API_KEY || null,
    clientId: env.CX_CLIENT_ID || null,
    clientSecret: env.CX_CLIENT_SECRET || null,
    tenant: env.CX_TENANT || null,
    baseUrl: env.CX_BASE_URL || null,
    iamUrl: env.CX_IAM_URL || null,
  };

  if (!cfg.apiKey && !(cfg.clientId && cfg.clientSecret)) {
    die('Set CX_API_KEY, or CX_CLIENT_ID and CX_CLIENT_SECRET.');
  }

  // An API key is a JWT whose "iss" is https://<iam-host>/auth/realms/<tenant>
  if (cfg.apiKey) {
    const p = decodeJwtPayload(cfg.apiKey);
    const m = p?.iss?.match(/^(https?:\/\/[^/]+)\/auth\/realms\/([^/]+)/);
    if (m) {
      cfg.iamUrl ||= m[1];
      cfg.tenant ||= m[2];
    }
  }

  if (!cfg.iamUrl && cfg.baseUrl) cfg.iamUrl = cfg.baseUrl.replace('://ast.', '://iam.').replace('.ast.', '.iam.');
  if (!cfg.baseUrl && cfg.iamUrl) cfg.baseUrl = cfg.iamUrl.replace('://iam.', '://ast.').replace('.iam.', '.ast.');

  if (!cfg.tenant) die('Could not determine tenant. Set CX_TENANT.');
  if (!cfg.baseUrl || !cfg.iamUrl) die('Could not determine URLs. Set CX_BASE_URL (and CX_IAM_URL if non-standard).');

  cfg.baseUrl = cfg.baseUrl.replace(/\/+$/, '');
  cfg.iamUrl = cfg.iamUrl.replace(/\/+$/, '');
  return cfg;
}

class CxClient {
  constructor(cfg) {
    this.cfg = cfg;
    this.token = null;
    this.tokenExpiresAt = 0;
  }

  async authenticate() {
    const { cfg } = this;
    const url = `${cfg.iamUrl}/auth/realms/${encodeURIComponent(cfg.tenant)}/protocol/openid-connect/token`;
    const body = new URLSearchParams(
      cfg.apiKey
        ? { grant_type: 'refresh_token', client_id: 'ast-app', refresh_token: cfg.apiKey }
        : { grant_type: 'client_credentials', client_id: cfg.clientId, client_secret: cfg.clientSecret },
    );
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    if (!res.ok) die(`Authentication failed (${res.status}): ${await res.text()}`);
    const json = await res.json();
    this.token = json.access_token;
    this.tokenExpiresAt = Date.now() + (json.expires_in ?? 1800) * 1000 - 60_000;
  }

  async request(path, { method = 'GET', body, raw = false, retries = 3 } = {}) {
    if (!this.token || Date.now() >= this.tokenExpiresAt) await this.authenticate();
    const url = path.startsWith('http') ? path : `${this.cfg.baseUrl}${path}`;
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: 'application/json; version=1.0',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    if (res.status === 401 && retries > 0) {
      this.token = null;
      return this.request(path, { method, body, raw, retries: retries - 1 });
    }
    if ((res.status === 429 || res.status >= 500) && retries > 0) {
      await sleep(2000 * (4 - retries));
      return this.request(path, { method, body, raw, retries: retries - 1 });
    }
    if (!res.ok) {
      throw new Error(`${method} ${url} -> ${res.status} ${(await res.text()).slice(0, 300)}`);
    }
    return raw ? res : res.json();
  }
}

// ------------------------------------------------------ Checkmarx One APIs --

function scaCompleted(scan) {
  const engines = (scan.engines || []).map((e) => String(e).toLowerCase());
  if (!engines.includes('sca')) return false;
  if (scan.status === 'Completed') return true;
  // Partial scans: accept if the SCA engine itself completed
  const sca = (scan.statusDetails || []).find((d) => String(d.name).toLowerCase() === 'sca');
  return scan.status === 'Partial' && sca?.status === 'Completed';
}

/** Walks scans newest-first and keeps the latest SCA scan of each distinct project. */
async function getLatestScaScanPerProject(client, maxProjects, branch) {
  const byProject = new Map();
  const pageSize = 200;
  for (let offset = 0; byProject.size < maxProjects; offset += pageSize) {
    const qs = new URLSearchParams({ offset, limit: pageSize, sort: '-created_at' });
    qs.append('statuses', 'Completed');
    qs.append('statuses', 'Partial');
    if (branch) qs.append('branch', branch);

    const page = await client.request(`/api/scans?${qs}`);
    const scans = page.scans || [];
    for (const s of scans) {
      if (byProject.has(s.projectId) || !scaCompleted(s)) continue;
      byProject.set(s.projectId, s);
      if (byProject.size >= maxProjects) break;
    }
    if (scans.length < pageSize) break; // no more pages
  }
  return [...byProject.values()];
}

/** Uses the SCA export service to get the full ScanReportJson for a scan. */
async function fetchScaReport(client, scanId, effectiveOnly) {
  const { exportId } = await client.request('/api/sca/export/requests', {
    method: 'POST',
    body: {
      scanId,
      fileFormat: 'ScanReportJson',
      exportParameters: {
        hideDevAndTestDependencies: false,
        showOnlyEffectiveLicenses: effectiveOnly,
      },
    },
  });
  if (!exportId) throw new Error(`No exportId returned for scan ${scanId}`);

  const deadline = Date.now() + 10 * 60_000;
  let status;
  do {
    await sleep(2000);
    status = await client.request(`/api/sca/export/requests?exportId=${encodeURIComponent(exportId)}`);
    if (status.exportStatus === 'Failed') throw new Error(`Export failed: ${status.errorMessage || 'unknown'}`);
    if (Date.now() > deadline) throw new Error('Export timed out');
  } while (status.exportStatus !== 'Completed');

  const fileUrl = status.fileUrl || `/api/sca/export/requests/${encodeURIComponent(exportId)}/download`;
  const res = await client.request(fileUrl, { raw: true });
  return res.json();
}

// ------------------------------------------------------- Report analysis --

const pick = (obj, ...keys) => {
  for (const k of keys) if (obj?.[k] !== undefined && obj[k] !== null) return obj[k];
  return undefined;
};

const licenseName = (l) => (typeof l === 'string' ? l : pick(l, 'Name', 'name', 'LicenseName', 'licenseName', 'ReferenceType'));

/** Returns true/false if the entry carries an explicit "effective" flag, otherwise undefined. */
const effectiveFlag = (l) => {
  if (typeof l !== 'object' || l === null) return undefined;
  const v = pick(l, 'IsEffectiveLicense', 'isEffectiveLicense', 'EffectiveLicense', 'effectiveLicense', 'IsEffective', 'isEffective');
  return typeof v === 'boolean' ? v : undefined;
};

/**
 * Builds { packageKey -> { name, version, manager, direct, licenses } } from a
 * ScanReportJson document. Licenses come from both Packages[].Licenses and the
 * top-level Licenses[] section, de-duplicated.
 */
export function analyseReport(report, { allLicenses = false } = {}) {
  const pkgs = new Map();
  const packages = pick(report, 'Packages', 'packages') || [];
  const licenseEntries = pick(report, 'Licenses', 'licenses') || [];

  const ensure = (id, name, version) => {
    const key = id || `${name}@${version}`;
    if (!pkgs.has(key)) {
      pkgs.set(key, { id: key, name, version, manager: '', direct: '', licenses: new Map() });
    }
    return pkgs.get(key);
  };

  // Track whether the report marks effective licenses explicitly anywhere.
  const all = [
    ...packages.flatMap((p) => pick(p, 'Licenses', 'licenses') || []),
    ...licenseEntries,
  ];
  const hasFlag = all.some((l) => effectiveFlag(l) !== undefined);

  const addLicense = (pkg, l) => {
    const name = licenseName(l);
    if (!name) return;
    if (!allLicenses && hasFlag && effectiveFlag(l) === false) return;
    const risk = typeof l === 'object' ? pick(l, 'RiskLevel', 'riskLevel') : undefined;
    const prev = pkg.licenses.get(name);
    pkg.licenses.set(name, prev || risk || '');
  };

  for (const p of packages) {
    const pkg = ensure(pick(p, 'Id', 'id'), pick(p, 'Name', 'name'), pick(p, 'Version', 'version'));
    pkg.name ||= pick(p, 'Name', 'name');
    pkg.version ||= pick(p, 'Version', 'version');
    pkg.manager = pick(p, 'PackageRepository', 'packageRepository', 'PackageManager', 'packageManager') || '';
    const direct = pick(p, 'IsDirectDependency', 'isDirectDependency');
    pkg.direct = direct === undefined ? '' : direct ? 'Direct' : 'Transitive';
    for (const l of pick(p, 'Licenses', 'licenses') || []) addLicense(pkg, l);
    for (const l of pick(p, 'EffectiveLicenses', 'effectiveLicenses') || []) addLicense(pkg, l);
  }

  for (const l of licenseEntries) {
    const id = pick(l, 'PackageId', 'packageId');
    const name = pick(l, 'PackageName', 'packageName');
    const version = pick(l, 'PackageVersion', 'packageVersion');
    if (!id && !name) continue;
    addLicense(ensure(id, name, version), l);
  }

  return [...pkgs.values()];
}

// ------------------------------------------------------------------ Output --

const csvCell = (v) => {
  const s = String(v ?? '');
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

function printList(rows, minLicenses) {
  if (!rows.length) {
    console.log(`\nNo packages with ${minLicenses}+ effective licenses found.`);
    return;
  }
  console.log(`\nPackages with ${minLicenses}+ effective licenses (${rows.length}):\n`);
  const cols = [
    ['Project', (r) => r.project],
    ['Package', (r) => r.package],
    ['Version', (r) => r.version],
    ['#', (r) => r.licenseCount],
    ['Effective licenses', (r) => r.licenses.join(' | ')],
  ];
  const widths = cols.map(([h, f]) => Math.min(60, Math.max(h.length, ...rows.map((r) => String(f(r)).length))));
  const fmt = (vals) => vals.map((v, i) => String(v).slice(0, widths[i]).padEnd(widths[i])).join('  ');
  console.log(fmt(cols.map(([h]) => h)));
  console.log(widths.map((w) => '-'.repeat(w)).join('  '));
  for (const r of rows) console.log(fmt(cols.map(([, f]) => f(r))));
}

async function writeOutputs(rows, summary, prefix) {
  const header = [
    'Project', 'ProjectId', 'Branch', 'ScanId', 'ScanDate',
    'Package', 'Version', 'PackageManager', 'Dependency',
    'LicenseCount', 'EffectiveLicenses', 'LicenseRiskLevels',
  ];
  const lines = [header.join(',')];
  for (const r of rows) {
    lines.push([
      r.project, r.projectId, r.branch, r.scanId, r.scanDate,
      r.package, r.version, r.manager, r.dependency,
      r.licenseCount, r.licenses.join(' | '), r.riskLevels.join(' | '),
    ].map(csvCell).join(','));
  }
  // BOM so Excel opens UTF-8 correctly
  await writeFile(`${prefix}.csv`, '﻿' + lines.join('\r\n') + '\r\n', 'utf8');
  await writeFile(`${prefix}.json`, JSON.stringify({ generatedAt: new Date().toISOString(), summary, packages: rows }, null, 2));
  log(`\nExported ${rows.length} row(s) to ${prefix}.csv and ${prefix}.json`);
}

// -------------------------------------------------------------------- Main --

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      results[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return results;
}

function toRows(scanMeta, packages, minLicenses) {
  return packages
    .filter((p) => p.licenses.size >= minLicenses)
    .map((p) => ({
      project: scanMeta.projectName,
      projectId: scanMeta.projectId,
      branch: scanMeta.branch || '',
      scanId: scanMeta.id,
      scanDate: scanMeta.createdAt || '',
      package: p.name,
      version: p.version || '',
      manager: p.manager,
      dependency: p.direct,
      licenseCount: p.licenses.size,
      licenses: [...p.licenses.keys()].sort(),
      riskLevels: [...p.licenses.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([n, r]) => `${n}:${r || 'n/a'}`),
    }));
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const effectiveOnly = !opts.allLicenses;
  const rows = [];
  const summary = { projectsScanned: 0, projectsWithHits: 0, failures: [] };

  if (opts.fromFile.length) {
    for (const file of opts.fromFile) {
      const report = JSON.parse(await readFile(file, 'utf8'));
      const meta = { projectName: basename(file), projectId: '', id: '', createdAt: '' };
      const hits = toRows(meta, analyseReport(report, { allLicenses: opts.allLicenses }), opts.minLicenses);
      summary.projectsScanned++;
      if (hits.length) summary.projectsWithHits++;
      rows.push(...hits);
    }
  } else {
    const client = new CxClient(resolveConfig());
    log(`Tenant: ${client.cfg.tenant}  |  ${client.cfg.baseUrl}`);
    await client.authenticate();

    log(`Finding the last ${opts.projects} projects with a completed SCA scan...`);
    const scans = await getLatestScaScanPerProject(client, opts.projects, opts.branch);
    log(`Found ${scans.length} project(s). Exporting SCA reports (concurrency ${opts.concurrency})...`);

    let done = 0;
    await mapLimit(scans, opts.concurrency, async (scan) => {
      try {
        const report = await fetchScaReport(client, scan.id, effectiveOnly);
        const hits = toRows(scan, analyseReport(report, { allLicenses: opts.allLicenses }), opts.minLicenses);
        rows.push(...hits);
        summary.projectsScanned++;
        if (hits.length) summary.projectsWithHits++;
        log(`  [${++done}/${scans.length}] ${scan.projectName}: ${hits.length} multi-license package(s)`);
      } catch (err) {
        summary.failures.push({ project: scan.projectName, scanId: scan.id, error: err.message });
        log(`  [${++done}/${scans.length}] ${scan.projectName}: FAILED - ${err.message}`);
      }
    });
  }

  rows.sort((a, b) => a.project.localeCompare(b.project) || b.licenseCount - a.licenseCount || a.package.localeCompare(b.package));
  summary.packagesFound = rows.length;

  printList(rows, opts.minLicenses);
  await writeOutputs(rows, summary, opts.out);
  log(`Projects analysed: ${summary.projectsScanned}, with multi-license packages: ${summary.projectsWithHits}, failures: ${summary.failures.length}`);
}

// Run only when executed directly (allows importing analyseReport in tests)
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('cx-sca-multi-license.mjs')) {
  main().catch((err) => die(err.stack || err.message));
}
