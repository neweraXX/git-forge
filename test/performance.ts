import { fork } from 'node:child_process';
import { runBenchmark } from '/kit/program/env/src/bench.ts';
const child = fork(new URL('./serve.ts', import.meta.url), [], {
  env: { ...process.env, MAKEFUN_SHOP_TOKEN: 'local-test-token' },
  stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
});
try {
  const port = await new Promise<number>((resolve, reject) => {
    child.once('message', (message: any) => resolve(message.port));
    child.once('error', reject); child.once('exit', code => reject(new Error(`Server exited ${code}`)));
  });
  const result = await runBenchmark({ baseUrl: `http://127.0.0.1:${port}`, token: 'local-test-token', deadlineMs: performance.now() + 240000, log: console.log });
  console.log(JSON.stringify(result, null, 2));
} finally { child.send('stop'); }
