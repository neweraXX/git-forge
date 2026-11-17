// Run with ./dock node test/workload-cpu.ts. Only the child serves requests;
// its process.cpuUsage excludes the benchmark client's hashing, JSON and sockets.
import { fork } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { runBenchmark } from '/kit/program/env/src/bench.ts';

const rows: any[] = [];
const repeats = Number(process.env.FORGE_CPU_REPEATS || 3);
const variants = JSON.parse(process.env.FORGE_CPU_VARIANTS || '[{"name":"current","app":"../app.ts"}]');
for (let repeat = 0; repeat < repeats; repeat++) {
 for (const variant of variants) {
  const child = fork(new URL('./serve.ts', import.meta.url), [], {
    execArgv: [...process.execArgv, ...(variant.flags || [])],
    env: { ...process.env, ...variant.env, FORGE_TEST_APP: variant.app, MAKEFUN_SHOP_TOKEN: 'local-test-token' },
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  });
  const port = await new Promise<number>((resolve, reject) => {
    child.once('message', (message: any) => resolve(message.port)); child.once('error', reject);
    child.once('exit', code => reject(new Error(`Server exited before listening: ${code}`)));
  });
  const queue: ((value: any) => void)[] = [];
  child.on('message', message => queue.shift()?.(message));
  function stats(): Promise<any> {
    return new Promise(resolve => { queue.push(resolve); child.send('stats'); });
  }
  try {
    for (const name of ['push', 'clone', 'read', 'write'] as const) {
      const before = await stats(), samples: Promise<any>[] = [];
      const result = await runBenchmark({
        baseUrl: `http://127.0.0.1:${port}`, token: 'local-test-token', workloads: [name], rounds: 5,
        log: line => { if (line.startsWith(`[bench] ${name} round `)) samples.push(stats()); },
      });
      const snapshots = await Promise.all(samples), after = await stats();
      const cpu = (s: any) => (s.cpu.user + s.cpu.system) / 1000;
      // Snapshot messages are queued at each round's end. Differences exclude setup,
      // warm-up and round one. Sequential workloads can race one following
      // request; a concurrent clone burst can straddle a snapshot boundary.
      const roundCpu = snapshots.slice(1).map((s, i) => cpu(s) - cpu(snapshots[i]));
      const workload = result.workloads[0];
      if (workload.error || snapshots.length !== 5) throw new Error(JSON.stringify(workload));
      const row = { repeat, variant: variant.name, name, p50_ms: workload.p50_ms, cpu_ms: roundCpu.reduce((a, b) => a + b, 0) / roundCpu.length, round_cpu_ms: roundCpu,
        total_cpu_ms: cpu(after) - cpu(before), rss_mb: after.memory / 1048576 };
      rows.push(row); console.log(JSON.stringify(row));
    }
  } finally {
    const stopped = new Promise(resolve => child.once('exit', resolve)); child.send('stop'); await stopped;
  }
 }
}
const summary = variants.flatMap((variant: any) => ['push', 'clone', 'read', 'write'].map(name => {
  const samples = rows.filter(row => row.name === name && row.variant === variant.name);
  const median = (key: string) => samples.map(row => row[key]).sort((a, b) => a - b)[Math.floor(samples.length / 2)];
  return { variant: variant.name, name, p50_ms: median('p50_ms'), cpu_ms: median('cpu_ms') };
}));
const timings = variants.map((variant: any) => ({ variant: variant.name, perf_p50_us: Math.round(1000 * Math.exp(summary.filter((row: any) => row.variant === variant.name).reduce((sum: number, row: any) => sum + Math.log(row.p50_ms), 0) / 4)) }));
const result = { summary, timings, rows };
writeFileSync(process.env.FORGE_CPU_OUTPUT || '/tmp/forge-workload-cpu.json', JSON.stringify(result, null, 2));
console.log(JSON.stringify(result.summary));
console.log(JSON.stringify(timings));
