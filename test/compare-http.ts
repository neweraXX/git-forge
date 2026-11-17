import { fork } from 'node:child_process';
import { runBenchmark } from '/kit/program/env/src/bench.ts';
const results: any[] = [];
for (const mode of ['node', 'raw', 'raw', 'node', 'node', 'raw']) {
  const child = fork(new URL('./serve.ts', import.meta.url), [], { env: { ...process.env, MAKEFUN_SHOP_TOKEN: 'local-test-token', FORGE_HTTP: mode }, stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
  const port = await new Promise<number>((resolve, reject) => { child.once('message', (m: any) => resolve(m.port)); child.once('error', reject); });
  try {
    const result = await runBenchmark({ baseUrl: `http://127.0.0.1:${port}`, token: 'local-test-token', deadlineMs: performance.now() + 240000, log: () => {} });
    const stats = await new Promise<any>(resolve => { child.once('message', resolve); child.send('stats'); });
    const row = { mode, perf_p50_us: result.perf_p50_us, ...Object.fromEntries(result.workloads.map((w: any) => [w.name, w.p50_ms])), cpu_ms: (stats.cpu.user + stats.cpu.system) / 1000, rss_mb: stats.memory / 1048576 };
    results.push(row); console.log(JSON.stringify(row));
  } finally { child.send('stop'); }
}
for (const mode of ['node', 'raw']) {
  const rows = results.filter(r => r.mode === mode), median = (key: string) => rows.map(r => r[key]).sort((a, b) => a - b)[1];
  console.log(JSON.stringify({ mode, median: Object.fromEntries(['perf_p50_us', 'push', 'clone', 'read', 'write', 'cpu_ms'].map(key => [key, median(key)])) }));
}
