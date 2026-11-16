// The workspace's grade 3 helper passes --trials, which is for scrape/v1 kits.
// Keep that helper untouched and invoke the agent/v1 three-instance grade inside ./dock.
import { spawn } from 'node:child_process';
const run = spawn(process.execPath, [
  '/kit/cli/makefun.mjs', 'grade-local', '--kit', '/kit', '--bot', '/bot',
  '--driver', 'process', '--worktree', '--instances', '3', '--save', '/tmp/forge-grade-three',
], { cwd: '/kit', stdio: 'inherit' });
process.exitCode = await new Promise<number>((resolve, reject) => {
  run.once('error', reject);
  run.once('exit', code => resolve(code ?? 1));
});
