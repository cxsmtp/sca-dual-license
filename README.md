# Checkmarx One – SCA multi-license package finder

`cx-sca-multi-license.mjs` connects to a Checkmarx One tenant, takes the **last 50 projects** that have a completed SCA scan, downloads each scan's SCA report, and lists every package with **more than one effective license**. Each package's name, version, licenses and risk levels are printed on screen and exported to CSV and JSON.

Needs Node.js 18 or newer. There is nothing to install.

## Option A: web page (paste your API key in the browser)

```bash
node cx-sca-web.mjs
```

Then open **http://localhost:3939** and paste your Checkmarx One API key. The page detects your tenant and region from the key. Click **Fetch results** to get:

- live progress for each project
- the list of packages with more than one effective license, which you can filter and sort
- **Export CSV**

Checkmarx One blocks API calls made directly from a browser, so this small local server makes the calls for the page. It only listens on `127.0.0.1`, keeps the key in memory for that run only, and never writes it to disk. To use a different port: `PORT=8080 node cx-sca-web.mjs`.

## Option B: command line

### Setup

Create an API key in Checkmarx One (**Settings → Identity and Access Management → API Keys**), then:

```bash
export CX_API_KEY='<your api key>'
```

The script reads the tenant and the IAM URL from the API key. If you need to set them yourself (or you use an OAuth client instead of an API key), set these:

| Variable | Example |
|---|---|
| `CX_BASE_URL` | `https://ast.checkmarx.net`, `https://eu.ast.checkmarx.net`, … |
| `CX_IAM_URL` | `https://iam.checkmarx.net` (worked out from `CX_BASE_URL` if not set) |
| `CX_TENANT` | your tenant name |
| `CX_CLIENT_ID` / `CX_CLIENT_SECRET` | OAuth client, used instead of an API key |

### Run

```bash
node cx-sca-multi-license.mjs
```

| Option | Default | Meaning |
|---|---|---|
| `--projects <n>` | 50 | How many of the most recently scanned projects to check |
| `--min-licenses <n>` | 2 | Report packages with at least *n* effective licenses |
| `--all-licenses` | off | Count every declared license, not only effective ones |
| `--branch <name>` | any | Only use scans of this branch |
| `--out <prefix>` | `./multi-license-report` | Prefix for the output files |
| `--concurrency <n>` | 4 | How many SCA exports run at once |
| `--from-file <path>` | – | Read a local SCA `ScanReportJson` export instead of calling the API (you can repeat it) |

Example output:

```
Packages with 2+ effective licenses (2):

Project   Package     Version  #  Effective licenses
--------  ----------  -------  -  -------------------------------------------
payments  javax.mail  1.6.2    2  CDDL-1.1 | GPL-2.0-with-classpath-exception
payments  jszip       3.10.1   2  GPL-3.0 | MIT
```

`multi-license-report.csv` columns: Project, ProjectId, Branch, ScanId, ScanDate, Package, Version, PackageManager, Dependency (Direct/Transitive), LicenseCount, EffectiveLicenses, LicenseRiskLevels.

To try it offline, run:

```bash
node cx-sca-multi-license.mjs --from-file examples/sample-scan-report.json
```

## How it works

1. It authenticates against `/auth/realms/<tenant>/protocol/openid-connect/token`. Expired tokens are renewed automatically.
2. It calls `GET /api/scans?sort=-created_at` (Completed and Partial scans), newest first, and keeps the latest scan of each project in which the SCA engine completed, until it has N projects.
3. For each of those scans it requests an SCA export: `POST /api/sca/export/requests` with `fileFormat: ScanReportJson` and `showOnlyEffectiveLicenses: true`. It polls until the export is ready, then downloads the report.
4. It merges licenses from `Packages[].Licenses` and the top-level `Licenses[]` section for each package, then keeps the packages whose license count is at or above `--min-licenses`.

## Notes

- **Corporate proxy:** Node's built-in `fetch` ignores `HTTPS_PROXY`. Behind a proxy, use Node 24+ with `NODE_USE_ENV_PROXY=1`.
- **Permissions:** the API key or client needs permission to view projects and scans, and to read and export SCA results.
