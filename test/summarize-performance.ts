import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (name: string) => readFileSync(new URL(name, import.meta.url), 'utf8');
const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
function cpu(version: string, cpus: number) {
  const rows = [1, 2, 3].map(n => {
    const log = read(`perf-${version}-cpu${cpus}-run${n}.log`);
    assert.match(log, /"feature":600/); assert.match(log, /"agent":200/);
    assert.match(log, /0 nondeterministic/);
    const m = /ENTRYCPU node_ms=(\d+) go_ms=(\d+) total_ms=(\d+)/.exec(log)!;
    assert.ok(m, log);
    const times = Object.fromEntries([...log.matchAll(/(push|clone|read|write)=([\d.]+)ms/g)].map(m => [m[1], Number(m[2])]));
    return { node_ms: +m[1], go_ms: +m[2], total_ms: +m[3], ...times };
  });
  return { samples: rows, medians: Object.fromEntries(Object.keys(rows[0]).map(key => [key, median(rows.map(r => r[key]))])) };
}
function workloads(version: string) {
  return Object.fromEntries(read(`perf-${version}-workloads.log`).trim().split('\n').map(s => JSON.parse(s)).filter(r => r.median).map(r => [r.workload, r.median]));
}
function grade(arch: string) {
  const log = read(`perf-final-${arch}.log`);
  assert.equal((log.match(/replay  matched:/g) || []).length, 3);
  assert.match(log, /trials    3 finished, 0 timeout, 0 nondeterministic/);
  const scores = [...log.matchAll(/^  scores  (\{.*?\})/gm)].map(m => JSON.parse(m[1]));
  assert.equal(scores.length, 3);
  for (const row of scores) { assert.equal(row.feature, 600); assert.equal(row.agent, 200); assert.ok(row.score >= 999); }
  return { scores, perf_p50_us: scores.map(r => r.perf_p50_us), replays: 3 };
}
const paired = JSON.parse(read('perf-paired-workloads.log').trim().split('\n').find(s => s.startsWith('PAIR_SUMMARY '))!.slice(13));
const result = { cpu2: { before: cpu('baseline', 2), after: cpu('final', 2) }, cpu1: { before: cpu('baseline', 1), after: cpu('final', 1) }, workloads: { before: workloads('baseline'), after: workloads('final') }, paired_workloads: paired, native: grade('native'), amd64: grade('amd64') };
console.log(JSON.stringify(result));
