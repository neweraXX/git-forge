process.env.FORGE_CPU_VARIANTS = JSON.stringify([
  { name: 'final-epoll-2-gc600-unlimited', env: { FORGE_GO_HTTP: 'epoll', FORGE_PROCS: '2', FORGE_GOGC: '600', FORGE_MEMORY_MB: '0' } },
]);
await import('./cpu-variants.ts');
