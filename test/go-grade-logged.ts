// The dock grade helpers discard their containers and successful stderr. Retain
// separate trials to assert that Go really served them, including the x64 binary.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const native = process.arch === 'arm64' ? 'arm64' : 'x64';
const runtime = ['main', 'app', 'router', 'transport', 'reader', 'writer', 'store', 'rest', 'git', 'inflate', 'graphql', 'mcp'];
for (const arch of native === 'arm64' ? ['arm64', 'x64'] : ['x64']) {
  const directory = mkdtempSync('/tmp/forge-logged-bot-');
  const save = `/tmp/forge-logged-${arch}`;
  try {
    for (const file of runtime) cpSync(`/bot/${file}.ts`, join(directory, `${file}.ts`));
    cpSync('/bot/package.json', join(directory, 'package.json'));
    mkdirSync(join(directory, 'bin'));
    cpSync(`/bot/bin/forge-${arch}`, join(directory, 'bin', `forge-${arch}`));
    // The native run uses the unmodified default entry. On arm64 the second run
    // executes the committed amd64 Go binary through the host's binfmt support.
    if (arch !== native) {
      const main = readFileSync(join(directory, 'main.ts'), 'utf8');
      const patched = main.replace("process.arch === 'arm64' ? 'arm64' : 'x64'", JSON.stringify(arch));
      assert.notEqual(patched, main);
      writeFileSync(join(directory, 'main.ts'), patched);
    }
    const run = spawn(process.execPath, ['/kit/cli/makefun.mjs', 'grade-local', '--kit', '/kit', '--bot', directory, '--driver', 'process', '--worktree', '--instances', '3', '--save', save], { cwd: '/kit', stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; run.stdout.on('data', chunk => output += chunk); run.stderr.on('data', chunk => output += chunk);
    const code = await new Promise<number | null>((resolve, reject) => { run.once('exit', resolve); run.once('error', reject); });
    assert.equal(code, 0, output);
    assert.equal((output.match(/replay  matched:/g) || []).length, 3, output);
    assert.equal((output.match(/"feature":600/g) || []).length, 4, output);
    for (let trial = 0; trial < 3; trial++) {
      const log = readFileSync(join(save, `trial-${trial}`, 'stderr.txt'), 'utf8');
      assert.match(log, /Forge Go server listening on \d+/);
      assert.doesNotMatch(log, /Forge binary fallback:/);
      const perf = JSON.parse(readFileSync(join(save, `trial-${trial}`, 'state', 'perf.json'), 'utf8'));
      console.log(JSON.stringify({ binary: arch, node: process.arch, trial, stderr: log.trim(), perf_p50_us: perf.perf_p50_us, workloads: perf.workloads.map((w: any) => ({ name: w.name, p50_ms: w.p50_ms })) }));
    }
    console.log(`${arch}: 3/3 trials passed 120/120, all replays matched, Go listener verified in every trial log`);
  } finally { rmSync(directory, { recursive: true, force: true }); }
}
