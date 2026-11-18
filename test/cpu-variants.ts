// Full-grade comparisons with settings injected into the entry, not inherited
// through the process driver. CPU includes live + replay, as ./dock cpu does.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const variants = JSON.parse(process.env.FORGE_CPU_VARIANTS || JSON.stringify([
  { name: 'epoll-1-gc100-limit128', env: { FORGE_GO_HTTP: 'epoll', FORGE_PROCS: '1', FORGE_GOGC: '100', FORGE_MEMORY_MB: '128' } },
  { name: 'epoll-1-gc400-unlimited', env: { FORGE_GO_HTTP: 'epoll', FORGE_PROCS: '1', FORGE_GOGC: '400', FORGE_MEMORY_MB: '0' } },
  { name: 'epoll-2-gc600-unlimited', env: { FORGE_GO_HTTP: 'epoll', FORGE_PROCS: '2', FORGE_GOGC: '600', FORGE_MEMORY_MB: '0' } },
  { name: 'tcp-1-gc600-unlimited', env: { FORGE_GO_HTTP: 'tcp', FORGE_PROCS: '1', FORGE_GOGC: '600', FORGE_MEMORY_MB: '0' } },
  { name: 'tcp-2-gc600-unlimited', env: { FORGE_GO_HTTP: 'tcp', FORGE_PROCS: '2', FORGE_GOGC: '600', FORGE_MEMORY_MB: '0' } },
]));
const runtime = ['main', 'app', 'router', 'transport', 'reader', 'writer', 'store', 'rest', 'git', 'inflate', 'graphql', 'mcp'];
const rows: any[] = [];
for (let repeat = 0; repeat < Number(process.env.FORGE_CPU_REPEATS || 3); repeat++) {
  for (const variant of repeat % 2 ? [...variants].reverse() : variants) {
    const directory = mkdtempSync('/tmp/cpu-variant-');
    const bot = join(directory, 'source'), save = join(directory, 'result');
    mkdirSync(bot); mkdirSync(join(bot, 'bin'));
    for (const name of runtime) cpSync(`/bot/${name}.ts`, join(bot, `${name}.ts`));
    cpSync('/bot/package.json', join(bot, 'package.json'));
    cpSync(`/bot/bin/forge-${process.arch === 'arm64' ? 'arm64' : 'x64'}`, join(bot, 'bin', `forge-${process.arch === 'arm64' ? 'arm64' : 'x64'}`));
    const settings = { FORGE_SERVER: 'go', GODEBUG: 'gctrace=1', ...variant.env };
    writeFileSync(join(bot, 'main.ts'), Object.entries(settings).map(([k, v]) => `process.env[${JSON.stringify(k)}] = ${JSON.stringify(v)};`).join('\n') + '\n' + readFileSync('/bot/main.ts', 'utf8'));
    const seen = new Map<string, { kind: string; ticks: number; rss: number }>();
    function sample() {
      for (const pid of readdirSync('/proc')) {
        if (!/^\d+$/.test(pid)) continue;
        try {
          const cmd = readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ');
          const kind = cmd.includes('/tmp/forge-') && !cmd.includes('main.ts') ? 'go' : cmd.includes('/bot/') && cmd.includes('main.ts') && !cmd.includes('cli/makefun') ? 'node' : '';
          if (!kind) continue;
          const fields = readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].split(' ');
          const ticks = Number(fields[11]) + Number(fields[12]);
          const rss = Number(/VmRSS:\s*(\d+)/.exec(readFileSync(`/proc/${pid}/status`, 'utf8'))?.[1] || 0) / 1024;
          const prior = seen.get(pid);
          seen.set(pid, { kind, ticks: Math.max(ticks, prior?.ticks || 0), rss: Math.max(rss, prior?.rss || 0) });
        } catch {}
      }
    }
    const timer = setInterval(sample, 20);
    try {
      const run = spawn(process.execPath, ['/kit/cli/makefun.mjs', 'grade-local', '--kit', '/kit', '--bot', bot, '--driver', 'process', '--worktree', '--save', save], { cwd: '/kit', stdio: ['ignore', 'pipe', 'pipe'] });
      let output = ''; run.stdout.on('data', c => output += c); run.stderr.on('data', c => output += c);
      const code = await new Promise<number | null>((resolve, reject) => { run.once('exit', resolve); run.once('error', reject); });
      assert.equal(code, 0, output); assert.match(output, /"feature":600/); assert.match(output, /replay  matched:/);
      const stderr = readFileSync(join(save, 'trial-0', 'stderr.txt'), 'utf8');
      assert.match(stderr, /Forge Go server listening/); assert.doesNotMatch(stderr, /Forge binary fallback/);
      const perf = JSON.parse(readFileSync(join(save, 'trial-0', 'state', 'perf.json'), 'utf8'));
      const cpu = (kind: string) => [...seen.values()].filter(v => v.kind === kind).reduce((n, v) => n + v.ticks * 10, 0);
      const row = { repeat, variant: variant.name, node_ms: cpu('node'), go_ms: cpu('go'), total_ms: cpu('node') + cpu('go'), go_rss_mb: Math.max(0, ...[...seen.values()].filter(v => v.kind === 'go').map(v => v.rss)), gc_live: (stderr.match(/^gc /gm) || []).length, perf_p50_us: perf.perf_p50_us, ...Object.fromEntries(perf.workloads.map((w: any) => [w.name, w.p50_ms])) };
      rows.push(row); console.log(JSON.stringify(row));
    } finally { clearInterval(timer); rmSync(directory, { recursive: true, force: true }); }
  }
}
for (const variant of variants) {
  const samples = rows.filter(r => r.variant === variant.name);
  const median = (key: string) => samples.map(r => r[key]).sort((a, b) => a - b)[Math.floor(samples.length / 2)];
  console.log(JSON.stringify({ variant: variant.name, medians: Object.fromEntries(['node_ms', 'go_ms', 'total_ms', 'go_rss_mb', 'gc_live', 'perf_p50_us', 'push', 'clone', 'read', 'write'].map(k => [k, median(k)])) }));
}
