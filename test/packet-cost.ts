import { pkt } from '../git.ts';
function previous(payload: string): Buffer {
  const data = Buffer.from(payload);
  return Buffer.concat([Buffer.from((data.length + 4).toString(16).padStart(4, '0')), data]);
}
const line = 'ok refs/heads/main\n';
for (const fast of [false, true, true, false, false, true]) {
  const start = process.cpuUsage(), time = performance.now(); let bytes = 0;
  for (let i = 0; i < 300000; i++) bytes += (fast ? pkt(line) : previous(line)).length;
  const cpu = process.cpuUsage(start);
  console.log(JSON.stringify({ fast, cpu_ms: (cpu.user + cpu.system) / 1000, wall_ms: performance.now() - time, bytes }));
}
