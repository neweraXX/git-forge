import { createApp } from './app.ts';

const endpoint = process.env.MAKEFUN_ENV_URL?.replace(/\/$/, '');
if (!endpoint) throw new Error('MAKEFUN_ENV_URL is required');
const server = createApp();
await new Promise<void>(resolve => server.listen(0, '0.0.0.0', resolve));
const port = (server.address() as { port: number }).port;
async function contact(path: string, body?: unknown): Promise<any> {
  const response = await fetch(endpoint + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok && response.status !== 409) throw new Error(`Lifecycle HTTP ${response.status}`);
  return response.status === 409 ? {} : response.json();
}
let registered = false;
for (;;) {
  try {
    if (!registered) { await contact('/register', { port }); registered = true; }
    if ((await contact('/done')).done) break;
  } catch (error) { process.stderr.write(`Lifecycle retry: ${String(error)}\n`); }
  await new Promise(resolve => setTimeout(resolve, 250));
}
server.close();
process.exit(0);
