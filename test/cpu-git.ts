process.env.FORGE_CPU_VARIANTS = JSON.stringify([
  { name: 'before', app: './.before-git/app.ts' },
  { name: 'after', app: '../app.ts' },
]);
await import('./workload-cpu.ts');
