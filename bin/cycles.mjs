#!/usr/bin/env node
/* import-cycle-report
 *
 * Scan a source tree, find the import cycles that can actually break it, write one HTML file.
 */

import { readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { dirname, join, basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyzeTree, worstSeverity, SEVERITY_ORDER, SEVERITY_RANK } from '../src/analyze.mjs';
import { renderHtml } from '../src/html.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(HERE, '..', 'package.json'), 'utf8'));

const USAGE = `import-cycle-report ${pkg.version}

  import-cycle-report <dir> [options]

  --out <file>        write the HTML report here (default cycles.html)
  --json <file>       also write the raw report as JSON
  --label <name>      what to call the tree in the report. Defaults to the directory name.
                      No absolute path ever reaches the output.
  --lang py|ts|both   which languages to analyse (default both)
  --ignore <name>     directory name to skip, repeatable, added to the defaults
  --fail-on <level>   exit 1 when a cycle at this level or worse exists.
                      breaks (default), fragile, lazy, types, or never
  --include-graph     put the full node and edge list in the JSON output
  --quiet             only print the summary line
  --help
`;

function parseArgs(argv) {
  const opts = {
    dir: null,
    out: 'cycles.html',
    json: null,
    label: null,
    lang: 'both',
    ignores: null,
    failOn: 'breaks',
    includeGraph: false,
    quiet: false,
  };
  const extraIgnores = [];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => {
      i += 1;
      if (i >= argv.length) throw new Error(`${a} needs a value`);
      return argv[i];
    };
    if (a === '--help' || a === '-h') return { help: true };
    else if (a === '--out') opts.out = next();
    else if (a === '--json') opts.json = next();
    else if (a === '--label') opts.label = next();
    else if (a === '--lang') opts.lang = next();
    else if (a === '--ignore') extraIgnores.push(next());
    else if (a === '--fail-on') opts.failOn = next();
    else if (a === '--include-graph') opts.includeGraph = true;
    else if (a === '--quiet') opts.quiet = true;
    else if (a.startsWith('-')) throw new Error(`unknown option ${a}`);
    else if (opts.dir === null) opts.dir = a;
    else throw new Error(`unexpected argument ${a}`);
  }
  if (extraIgnores.length > 0) opts.extraIgnores = extraIgnores;
  return opts;
}

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (e) {
    process.stderr.write(`${e.message}\n\n${USAGE}`);
    return 2;
  }
  if (opts.help || !opts.dir) {
    process.stdout.write(USAGE);
    return opts.help ? 0 : 2;
  }
  if (!['py', 'ts', 'both'].includes(opts.lang)) {
    process.stderr.write(`--lang must be py, ts or both, got ${opts.lang}\n`);
    return 2;
  }
  if (![...SEVERITY_ORDER, 'never'].includes(opts.failOn)) {
    process.stderr.write(`--fail-on must be one of ${SEVERITY_ORDER.join(', ')}, never\n`);
    return 2;
  }
  const root = resolve(opts.dir);
  try {
    if (!statSync(root).isDirectory()) throw new Error('not a directory');
  } catch {
    process.stderr.write(`cannot read directory: ${opts.dir}\n`);
    return 2;
  }

  const { DEFAULT_IGNORES } = await import('../src/scan.mjs');
  const ignores = opts.extraIgnores ? [...DEFAULT_IGNORES, ...opts.extraIgnores] : undefined;

  let report;
  try {
    report = analyzeTree(root, {
      lang: opts.lang,
      ignores,
      label: opts.label || basename(root),
      version: pkg.version,
      includeGraph: opts.includeGraph,
    });
  } catch (e) {
    process.stderr.write(`analysis failed: ${e.message}\n`);
    return 3;
  }

  mkdirSync(dirname(resolve(opts.out)), { recursive: true });
  writeFileSync(opts.out, renderHtml(report));
  if (opts.json) {
    mkdirSync(dirname(resolve(opts.json)), { recursive: true });
    writeFileSync(opts.json, JSON.stringify(report, null, 2) + '\n');
  }

  const b = report.bySeverity;
  if (!opts.quiet) {
    for (const c of report.cycles.filter((x) => x.severity === 'breaks').slice(0, 10)) {
      process.stdout.write(`breaks: ${c.nodes.join(' -> ')} -> ${c.nodes[0]}\n`);
    }
    if (report.unresolved.length > 0) {
      process.stdout.write(
        `graph is INCOMPLETE: ${report.unresolved.length} import(s) have a computed target\n`,
      );
      for (const u of report.unresolved.slice(0, 5)) {
        process.stdout.write(`  ${u.file}:${u.line} ${u.reason}\n`);
      }
    }
    for (const p of report.parseErrors.slice(0, 5)) {
      process.stdout.write(`parse error: ${p.file}: ${p.message}\n`);
    }
  }
  process.stdout.write(
    `${report.label}: ${report.totals.modules} modules, ${report.totals.edges} edges, ` +
      `${b.breaks} breaking, ${b.fragile} fragile, ${b.lazy} deferred, ${b.types} types-only -> ${opts.out}\n`,
  );

  if (opts.failOn === 'never') return 0;
  const worst = worstSeverity(report);
  if (worst && SEVERITY_RANK[worst] >= SEVERITY_RANK[opts.failOn]) return 1;
  return 0;
}

process.exitCode = await main();
