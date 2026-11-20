process.env.FORGE_CPU_VARIANTS = JSON.stringify([
  { name: 'epoll-2-gc600-locked', env: { FORGE_PROCS: '2', FORGE_GOGC: '600', FORGE_LOCK_THREAD: '1' } },
  { name: 'epoll-1-gc600-locked', env: { FORGE_PROCS: '1', FORGE_GOGC: '600', FORGE_LOCK_THREAD: '1' } },
  { name: 'epoll-2-gc100-locked', env: { FORGE_PROCS: '2', FORGE_GOGC: '100', FORGE_LOCK_THREAD: '1' } },
  { name: 'epoll-1-gc100-locked', env: { FORGE_PROCS: '1', FORGE_GOGC: '100', FORGE_LOCK_THREAD: '1' } },
  { name: 'epoll-2-gcoff-locked', env: { FORGE_PROCS: '2', FORGE_GOGC: '-1', FORGE_LOCK_THREAD: '1' } },
  { name: 'epoll-1-gcoff-locked', env: { FORGE_PROCS: '1', FORGE_GOGC: '-1', FORGE_LOCK_THREAD: '1' } },
  { name: 'epoll-2-gc600-unlocked', env: { FORGE_PROCS: '2', FORGE_GOGC: '600', FORGE_LOCK_THREAD: '0' } },
  { name: 'epoll-1-gc600-unlocked', env: { FORGE_PROCS: '1', FORGE_GOGC: '600', FORGE_LOCK_THREAD: '0' } },
]);
await import('./cpu-variants.ts');
