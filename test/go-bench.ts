// Native measurements with exactly the sealed workloads, one server per row.
import { fork } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { runBenchmark } from '/kit/program/env/src/bench.ts';
import { goServer } from './go-serve.ts';
const variants = [
  { name: 'node', env: {} },
  { name: 'go-tcp-1-100', env: { FORGE_GO_HTTP: 'tcp', FORGE_PROCS: '1', FORGE_GOGC: '100' } },
  { name: 'go-epoll-1-100-64', env: { FORGE_GO_HTTP: 'epoll', FORGE_PROCS: '1', FORGE_GOGC: '100', FORGE_MEMORY_MB: '64' } },
  { name: 'go-epoll-1-100-128', env: { FORGE_GO_HTTP: 'epoll', FORGE_PROCS: '1', FORGE_GOGC: '100', FORGE_MEMORY_MB: '128' } },
  { name: 'go-epoll-1-100-384', env: { FORGE_GO_HTTP: 'epoll', FORGE_PROCS: '1', FORGE_GOGC: '100', FORGE_MEMORY_MB: '384' } },
  { name: 'go-epoll-2-100-128', env: { FORGE_GO_HTTP: 'epoll', FORGE_PROCS: '2', FORGE_GOGC: '100', FORGE_MEMORY_MB: '128' } },
];
const rows: any[] = [];
for (let repeat = 0; repeat < 3; repeat++) {
  for (const variant of repeat % 2 ? [...variants].reverse() : variants) {
    const env = { MAKEFUN_SHOP_TOKEN: 'go-bench', ...variant.env };
    let child: any, port: number, stop: () => Promise<any>;
    if (variant.name === 'node') {
      child = fork(new URL('./serve.ts', import.meta.url), [], { env: { ...process.env, ...env }, stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
      port = await new Promise<number>((resolve, reject) => { child.once('message', (m: any) => resolve(m.port)); child.once('error', reject); });
      stop = async () => { const ended = new Promise(resolve => child.once('exit', resolve)); child.send('stop'); await ended; };
    } else { const server = await goServer(env); ({ child, port, stop } = server); }
    function cpu() { const fields = readFileSync(`/proc/${child.pid}/stat`, 'utf8').split(' '); return (Number(fields[13]) + Number(fields[14])) * 10; }
    try {
      const measured: any = {}, cpuMs: any = {};
      for (const name of ['push', 'clone', 'read', 'write'] as const) {
        const snapshots: number[] = [];
        const result = await runBenchmark({ baseUrl: `http://127.0.0.1:${port}`, token: env.MAKEFUN_SHOP_TOKEN, workloads: [name], rounds: 5, log: line => { if (line.startsWith(`[bench] ${name} round `)) snapshots.push(cpu()); } });
        const workload = result.workloads[0]; if (workload.error) throw new Error(JSON.stringify(workload));
        measured[name] = workload.p50_ms; cpuMs[name] = (snapshots.at(-1)! - snapshots[0]) / 4;
      }
      const row = { repeat, variant: variant.name, perf_p50_us: Math.round(1000 * Math.exp(Object.values(measured).reduce((sum: number, n: any) => sum + Math.log(n), 0) / 4)), ...measured, cpu_ms: cpuMs };
      rows.push(row); console.log(JSON.stringify(row));
    } finally { await stop(); }
  }
}
for (const variant of variants) {
  const samples = rows.filter(r => r.variant === variant.name);
  const median = (key: string) => samples.map(r => r[key]).sort((a, b) => a - b)[1];
  console.log(JSON.stringify({ variant: variant.name, median: Object.fromEntries(['perf_p50_us', 'push', 'clone', 'read', 'write'].map(k => [k, median(k)])), cpu_ms: Object.fromEntries(['push', 'clone', 'read', 'write'].map(k => [k, samples.map(r => r.cpu_ms[k]).sort((a, b) => a - b)[1]])) }));
}
