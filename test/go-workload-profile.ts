process.env.PROFILE = '1';
process.env.REPEATS = '1';
process.env.ROUNDS = '25';
await import('./go-workload-metrics.ts');
