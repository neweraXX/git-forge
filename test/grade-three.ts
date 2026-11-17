// The workspace's grade 3 helper passes --trials, which is for scrape/v1 kits.
// Keep that helper untouched and invoke the agent/v1 three-instance grade inside ./dock.
import { spawn } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
const run = spawn(process.execPath, [
  '/kit/cli/makefun.mjs', 'grade-local', '--kit', '/kit', '--bot', '/bot',
  '--driver', 'process', '--worktree', '--instances', '3', '--save', '/tmp/forge-grade-three',
], { cwd: '/kit', stdio: 'inherit' });
process.exitCode = await new Promise<number>((resolve, reject) => {
  run.once('error', reject);
  run.once('exit', code => resolve(code ?? 1));
});
if (!process.exitCode) {
  const rows: any[] = [];
  function inspect(directory: string): void {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) inspect(path);
      else if (entry.name === 'perf.json') {
        const perf = JSON.parse(readFileSync(path, 'utf8'));
        rows.push({ file: path, perf_p50_us: perf.perf_p50_us, workloads: perf.workloads });
      }
    }
  }
  inspect('/tmp/forge-grade-three');
  for (const row of rows) console.log(JSON.stringify(row));
}
