import { fork } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { runBenchmark } from '/kit/program/env/src/bench.ts';
const directory = '/tmp/forge-cpu-profile'; mkdirSync(directory, { recursive: true });
const child = fork(new URL('./serve.ts', import.meta.url), [], { execArgv: ['--cpu-prof', '--cpu-prof-interval=100', `--cpu-prof-dir=${directory}`], env: { ...process.env, MAKEFUN_SHOP_TOKEN: 'local-test-token' }, stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
const port = await new Promise<number>((resolve, reject) => { child.once('message', (m: any) => resolve(m.port)); child.once('error', reject); });
try {
  const result = await runBenchmark({ baseUrl: `http://127.0.0.1:${port}`, token: 'local-test-token', deadlineMs: performance.now() + 240000, log: () => {} });
  const stats = await new Promise<any>(resolve => { child.once('message', resolve); child.send('stats'); });
  console.log(JSON.stringify({ perf_p50_us: result.perf_p50_us, stats }));
} finally {
  const stopped = new Promise(resolve => child.once('exit', resolve)); child.send('stop'); await stopped;
}
for (const file of readdirSync(directory)) {
  const profile = JSON.parse(readFileSync(directory + '/' + file, 'utf8'));
  const nodes = new Map(profile.nodes.map((n: any) => [n.id, n]));
  const counts = new Map<number, number>();
  for (const id of profile.samples) counts.set(id, (counts.get(id) || 0) + 1);
  const rows = [...counts].map(([id, count]) => ({ frame: (nodes.get(id) as any).callFrame, count })).filter(row => row.frame.functionName !== '(idle)').sort((a, b) => b.count - a.count).slice(0, 35);
  for (const row of rows) console.log(JSON.stringify({ samples: row.count, name: row.frame.functionName, url: row.frame.url, line: row.frame.lineNumber + 1 }));
}
