process.env.FORGE_CPU_VARIANTS = JSON.stringify([
  { name: 'default', app: '../app.ts' },
  { name: 'semi16', app: '../app.ts', flags: ['--max-semi-space-size=16'] },
  { name: 'semi64', app: '../app.ts', flags: ['--max-semi-space-size=64'] },
  { name: 'serialCompile', app: '../app.ts', flags: ['--no-concurrent-recompilation'] },
]);
await import('./workload-cpu.ts');
