process.env.FORGE_CPU_VARIANTS = JSON.stringify([
  { name: 'stream', app: '../app.ts', env: { FORGE_READER: 'stream' } },
  { name: 'native', app: '../app.ts' },
]);
await import('./workload-cpu.ts');
