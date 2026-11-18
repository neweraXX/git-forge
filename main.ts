import { createApp } from './app.ts';
import { spawn, type ChildProcess } from 'node:child_process';
import { copyFile, chmod, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const endpoint = process.env.MAKEFUN_ENV_URL?.replace(/\/$/, '');
if (!endpoint) throw new Error('MAKEFUN_ENV_URL is required');
let child: ChildProcess | undefined, directory: string | undefined;
let server: ReturnType<typeof createApp> | undefined;
async function startBinary(): Promise<number> {
  directory = await mkdtemp(join(tmpdir(), 'forge-'));
  const binary = join(directory, 'forge');
  await copyFile(fileURLToPath(new URL(`./bin/forge-${process.arch === 'arm64' ? 'arm64' : 'x64'}`, import.meta.url)), binary);
  await chmod(binary, 0o755);
  child = spawn(binary, [], { env: process.env, stdio: ['ignore', 'pipe', 'inherit'] });
  const port = await new Promise<number>((resolve, reject) => {
    let output = '', settled = false;
    const finish = (error?: Error, value?: number) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      child!.stdout!.removeListener('data', onData);
      error ? reject(error) : resolve(value!);
    };
    const onData = (chunk: Buffer) => {
      output += chunk.toString();
      const newline = output.indexOf('\n');
      if (newline < 0) { if (output.length > 64) finish(new Error('Invalid forge port')); return; }
      const line = output.slice(0, newline).trim(), value = Number(line);
      if (!/^\d+$/.test(line) || !Number.isInteger(value) || value < 1 || value > 65535) finish(new Error('Invalid forge port'));
      else finish(undefined, value);
    };
    const timer = setTimeout(() => finish(new Error('Forge startup timed out')), 5000);
    child!.stdout!.on('data', onData);
    child!.once('error', error => finish(error));
    child!.once('exit', () => finish(new Error('Forge exited before startup')));
  });
  const health = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(1000) });
  if (!health.ok || !(await health.json()).ok || child.exitCode !== null || child.signalCode !== null) throw new Error('Forge health check failed');
  return port;
}
async function stopBinary(): Promise<void> {
  if (child && child.exitCode === null && child.signalCode === null) {
    const ended = new Promise<void>(resolve => child!.once('exit', () => resolve()));
    child.kill('SIGKILL'); await ended;
  }
  if (directory) await rm(directory, { recursive: true, force: true });
}
let port: number;
function terminate(): void { child?.kill('SIGKILL'); server?.close(); process.exit(0); }
process.once('SIGTERM', terminate); process.once('SIGINT', terminate);
process.once('exit', () => child?.kill('SIGKILL'));
try {
  if (process.env.FORGE_SERVER === 'node') throw new Error('Node server requested');
  port = await startBinary();
  process.stderr.write(`Forge Go server listening on ${port}\n`);
} catch (error) {
  await stopBinary();
  if (process.env.FORGE_SERVER !== 'node') process.stderr.write(`Forge binary fallback: ${String(error)}\n`);
  server = createApp();
  await new Promise<void>(resolve => server!.listen(0, '0.0.0.0', resolve));
  port = (server.address() as { port: number }).port;
}
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
server?.close();
await stopBinary();
process.exit(0);
