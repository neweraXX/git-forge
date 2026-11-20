// Exact sealed workloads; exclude setup, warm-up and round one. Measurements use
// /proc/<pid>/stat for child-only CPU and an idle stdin channel for MemStats.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { runBenchmark } from '/kit/program/env/src/bench.ts';

const rows: any[] = [];
const repeats = Number(process.env.REPEATS || 3);
const rounds = Number(process.env.ROUNDS || 11);
const realFetch = globalThis.fetch;
let barrier: Promise<any> = Promise.resolve();
globalThis.fetch = async (...args: Parameters<typeof fetch>) => { await barrier; return realFetch(...args); };
for (let repeat = 0; repeat < repeats; repeat++) {
  const child = spawn(`/bot/bin/forge-${process.arch === 'arm64' ? 'arm64' : 'x64'}`, [], {
    env: { ...process.env, MAKEFUN_SHOP_TOKEN: 'metrics', FORGE_DIAGNOSTICS: '1' }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  const exited = new Promise<number | null>((resolve, reject) => { child.once('exit', resolve); child.once('error', reject); });
  const port = await new Promise<number>((resolve, reject) => {
    let out = ''; child.stdout.on('data', b => { out += b; if (out.includes('\n')) resolve(Number(out.split('\n')[0])); });
    child.once('error', reject); child.once('exit', code => reject(new Error(`exit ${code}`)));
  });
  const cpu = () => { const f = readFileSync(`/proc/${child.pid}/stat`, 'utf8').split(') ')[1].split(' '); return (Number(f[11]) + Number(f[12])) * 10; };
  let stderr = '', pending: ((line: string) => void) | undefined;
  child.stderr.on('data', b => {
    stderr += b;
    let n: number;
    while ((n = stderr.indexOf('\n')) >= 0) {
      const line = stderr.slice(0, n); stderr = stderr.slice(n + 1);
      if (pending && /^(METRICS|PROFILE) /.test(line)) { const done = pending; pending = undefined; done(line); }
      else console.error(line);
    }
  });
  async function command(text: string) {
    assert.equal(pending, undefined);
    return Promise.race([
      new Promise<string>(resolve => { pending = resolve; child.stdin.write(text + '\n'); }),
      exited.then(code => { throw new Error(`Go exited during diagnostics: ${code}`); }),
    ]);
  }
  try {
    for (const name of ['push', 'clone', 'read', 'write'] as const) {
      const snapshots: any[] = [], tasks: Promise<any>[] = [];
      const result = await runBenchmark({ baseUrl: `http://127.0.0.1:${port}`, token: 'metrics', workloads: [name], rounds,
        log: line => {
          if (line.startsWith(`[bench] ${name} round `)) {
            const task = barrier.then(async () => {
              const m = JSON.parse((await command('stats')).slice(8)); snapshots.push({ cpu: cpu(), ...m });
              if (process.env.PROFILE && snapshots.length === 1) await command(`profile /tmp/forge-${child.pid}-${name}.pprof`);
              if (process.env.PROFILE && snapshots.length === rounds) {
                await command('stop');
                summarizeProfile(name, readFileSync(`/tmp/forge-${child.pid}-${name}.pprof`));
              }
            });
            tasks.push(task); barrier = task;
          }
        },
      });
      await Promise.all(tasks);
      assert.equal(result.workloads[0].error, undefined, JSON.stringify(result));
      const first = snapshots[0], last = snapshots.at(-1), ops = result.workloads[0].ops * (rounds - 1);
      const row = { repeat, workload: name, ops, cpu_us_op: (last.cpu - first.cpu) * 1000 / ops,
        rusage_us_op: (last.CPUus - first.CPUus) / ops,
        allocs_op: (last.Mallocs - first.Mallocs) / ops, bytes_op: (last.Bytes - first.Bytes) / ops,
        gc: last.GC - first.GC, p50_ms: result.workloads[0].p50_ms };
      rows.push(row); console.log(JSON.stringify(row));
    }
  } finally { child.kill('SIGKILL'); await exited; }
}
globalThis.fetch = realFetch;
for (const name of ['push', 'clone', 'read', 'write']) {
  const samples = rows.filter(r => r.workload === name);
  const median = (key: string) => samples.map(r => r[key]).sort((a, b) => a - b)[Math.floor(samples.length / 2)];
  console.log(JSON.stringify({ workload: name, median: Object.fromEntries(['cpu_us_op', 'rusage_us_op', 'allocs_op', 'bytes_op', 'gc', 'p50_ms'].map(k => [k, median(k)])) }));
}

// Decode the standard pprof protobuf with built-ins so profiles can be inspected
// inside the Node-only benchmark container. No Go tools or dependencies needed.
function fields(b: Uint8Array): Map<number, any[]> {
  let p = 0;
  function variable() { let n = 0, scale = 1; for (;;) { const v = b[p++]; n += (v & 127) * scale; if (!(v & 128)) return n; scale *= 128; } }
  const result = new Map<number, any[]>();
  while (p < b.length) {
    const tag = variable(), field = tag >>> 3, wire = tag & 7;
    let v: any;
    if (wire === 0) v = variable();
    else if (wire === 2) { const n = variable(); v = b.subarray(p, p + n); p += n; }
    else throw new Error(`unexpected protobuf wire ${wire}`);
    if (!result.has(field)) result.set(field, []); result.get(field)!.push(v);
  }
  return result;
}
function packed(b: Uint8Array): number[] {
  const values = []; let n = 0, scale = 1;
  for (const v of b) { n += (v & 127) * scale; if (v & 128) scale *= 128; else { values.push(n); n = 0; scale = 1; } }
  return values;
}
function summarizeProfile(workload: string, data: Buffer) {
  const p = fields(gunzipSync(data)), strings = p.get(6)!.map(b => Buffer.from(b).toString());
  const functions = new Map(p.get(5)!.map(b => { const f = fields(b); return [f.get(1)![0], strings[f.get(2)![0]]]; }));
  const locations = new Map(p.get(4)!.map(b => { const l = fields(b); return [l.get(1)![0], (l.get(4) || []).map(b => functions.get(fields(b).get(1)![0]))]; }));
  const flat = new Map<string, number>(), cumulative = new Map<string, number>();
  for (const b of p.get(2) || []) {
    const s = fields(b), ids = s.get(1)!.flatMap(v => typeof v === 'number' ? [v] : packed(v)), values = s.get(2)!.flatMap(v => typeof v === 'number' ? [v] : packed(v));
    const names = ids.flatMap(id => locations.get(id) || []), cpuMs = values[1] / 1e6;
    flat.set(names[0], (flat.get(names[0]) || 0) + cpuMs);
    for (const name of new Set(names)) cumulative.set(name, (cumulative.get(name) || 0) + cpuMs);
  }
  console.log(JSON.stringify({ profile: workload, flat_ms: [...flat].sort((a, b) => b[1] - a[1]).slice(0, 20), cumulative_ms: [...cumulative].sort((a, b) => b[1] - a[1]).slice(0, 25) }));
}
