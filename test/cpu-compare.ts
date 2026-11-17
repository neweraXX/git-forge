// Materialize an earlier runtime's .ts files in test/.baseline/ using git show
// before running this diagnostic. The baseline is not part of the entry.
process.env.FORGE_CPU_VARIANTS = JSON.stringify([
  { name: 'baseline', app: './.baseline/app.ts' },
  { name: 'current', app: '../app.ts' },
]);
await import('./workload-cpu.ts');
