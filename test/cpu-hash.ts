// The comparison snapshot is the runtime before one-shot hashing.
process.env.FORGE_CPU_VARIANTS = JSON.stringify([
  { name: 'before', app: './.before-json/app.ts' },
  { name: 'after', app: '../app.ts' },
]);
await import('./workload-cpu.ts');
