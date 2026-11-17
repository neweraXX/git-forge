import { spawn } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
const directory = '/tmp/forge-grade-details';
const run = spawn(process.execPath, [
  '/kit/cli/makefun.mjs', 'grade-local', '--kit', '/kit', '--bot', process.env.FORGE_TEST_BOT || '/bot',
  '--driver', 'process', '--worktree', '--save', directory,
], { cwd: '/kit', stdio: 'inherit' });
const code = await new Promise<number>((resolve, reject) => { run.once('error', reject); run.once('exit', value => resolve(value ?? 1)); });
function inspect(dir: string): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) inspect(path);
    else if (entry.name === 'perf.json') {
      const value = JSON.parse(readFileSync(path, 'utf8'));
      console.log(JSON.stringify({ file: path, perf_p50_us: value.perf_p50_us, points: value.points_total, workloads: value.workloads?.map((w: any) => ({ name: w.name, p50_ms: w.p50_ms, rounds: w.rounds })) }));
    }
  }
}
if (code === 0) inspect(directory);
process.exitCode = code;
