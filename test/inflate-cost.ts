import { deflateSync, inflateSync } from 'node:zlib';
const inputs = [Buffer.alloc(1024, 97), Buffer.from('100644 file.txt\0' + 'a'.repeat(20)), Buffer.from('tree ' + 'a'.repeat(40) + '\nparent ' + 'b'.repeat(40) + '\nauthor Test <t@example.invalid> 1700000000 +0000\ncommitter Test <t@example.invalid> 1700000000 +0000\n\nchange\n')];
const compressed = inputs.map(data => deflateSync(data));
for (const small of [false, true, true, false, false, true]) {
  const start = process.cpuUsage(), time = performance.now(); let allocated = 0;
  for (let i = 0; i < 10000; i++) {
    const index = i % inputs.length;
    const result = inflateSync(compressed[index], { info: true, chunkSize: small ? Math.max(64, inputs[index].length) : 16384 }) as any;
    allocated += result.buffer.buffer.byteLength;
  }
  const cpu = process.cpuUsage(start);
  console.log(JSON.stringify({ small, cpu_ms: (cpu.user + cpu.system) / 1000, wall_ms: performance.now() - time, backing_bytes: allocated }));
}
