// Isolated, temporary runtime snapshots; owner metadata and README are never copied.
import { spawn } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const runtime = ['main', 'app', 'router', 'transport', 'reader', 'writer', 'store', 'rest', 'git', 'inflate', 'graphql', 'mcp'];
const variants = [
  { name: 'node', env: { FORGE_SERVER: 'node' } },
  { name: 'go', env: { FORGE_GO_HTTP: 'epoll', FORGE_PROCS: '1' } },
];
for (const variant of variants) {
  const directory = mkdtempSync('/tmp/forge-grade-bot-');
  for (const name of runtime) cpSync(`/bot/${name}.ts`, join(directory, `${name}.ts`));
  cpSync('/bot/package.json', join(directory, 'package.json'));
  mkdirSync(join(directory, 'bin'));
  cpSync('/bot/bin', join(directory, 'bin'), { recursive: true });
  const prelude = Object.entries(variant.env).map(([k, v]) => `process.env[${JSON.stringify(k)}] = ${JSON.stringify(v)};`).join('\n');
  writeFileSync(join(directory, 'main.ts'), prelude + '\n' + readFileSync('/bot/main.ts', 'utf8'));
  const save = `/tmp/forge-compare-${variant.name}`;
  try {
    const run = spawn(process.execPath, ['/kit/cli/makefun.mjs', 'grade-local', '--kit', '/kit', '--bot', directory, '--driver', 'process', '--worktree', '--instances', '3', '--save', save], { cwd: '/kit', stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; run.stdout.on('data', chunk => output += chunk); run.stderr.on('data', chunk => output += chunk);
    const code = await new Promise<number | null>((resolve, reject) => { run.once('exit', resolve); run.once('error', reject); });
    console.log(output.split('\n').filter(line => /replay |scores |trials |regrade:|nondeterministic/.test(line)).join('\n'));
    if (code) throw new Error(output);
    const rows: any[] = [];
    function inspect(path: string) {
      for (const entry of readdirSync(path, { withFileTypes: true })) {
        const file = join(path, entry.name);
        if (entry.isDirectory()) inspect(file);
        else if (entry.name === 'perf.json') { const perf = JSON.parse(readFileSync(file, 'utf8')); rows.push({ variant: variant.name, file, perf_p50_us: perf.perf_p50_us, ...Object.fromEntries(perf.workloads.map((w: any) => [w.name, w.p50_ms])) }); }
      }
    }
    inspect(save);
    for (const row of rows) console.log(JSON.stringify(row));
    const median = (key: string) => rows.map(r => r[key]).sort((a, b) => a - b)[Math.floor(rows.length / 2)];
    console.log(JSON.stringify({ variant: variant.name, median: Object.fromEntries(['perf_p50_us', 'push', 'clone', 'read', 'write'].map(k => [k, median(k)])) }));
  } finally { rmSync(directory, { recursive: true, force: true }); }
}
