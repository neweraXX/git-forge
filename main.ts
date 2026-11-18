import { spawn, type ChildProcess } from 'node:child_process';
import { copyFile, chmod, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Agent, request as httpRequest } from 'node:http';

const endpoint = process.env.MAKEFUN_ENV_URL?.replace(/\/$/, '');
if (!endpoint) throw new Error('MAKEFUN_ENV_URL is required');
const lifecycleAgent = new Agent({ keepAlive: true, maxSockets: 1 });
async function requestJson(address: string, body?: unknown, timeout = 10000, pooled = true): Promise<any> {
  const target = new URL(address);
  const request = target.protocol === 'https:' ? (await import('node:https')).request : httpRequest;
  const data = body === undefined ? undefined : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = request(target, {
      method: data === undefined ? 'GET' : 'POST',
      headers: data === undefined ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) },
      agent: target.protocol === 'http:' ? (pooled ? lifecycleAgent : false) : undefined,
    });
    const timer = setTimeout(() => req.destroy(new Error('Lifecycle request timed out')), timeout);
    req.once('error', error => { clearTimeout(timer); reject(error); });
    req.once('response', response => {
      let text = ''; response.setEncoding('utf8');
      response.on('data', chunk => { text += chunk; });
      response.once('error', error => { clearTimeout(timer); reject(error); });
      response.once('end', () => {
        clearTimeout(timer);
        const status = response.statusCode || 0;
        if ((status < 200 || status >= 300) && status !== 409) { reject(new Error(`Lifecycle HTTP ${status}`)); return; }
        try { resolve(status === 409 ? {} : JSON.parse(text)); } catch (error) { reject(error); }
      });
    });
    req.end(data);
  });
}
let child: ChildProcess | undefined, directory: string | undefined;
let server: ReturnType<typeof import('./app.ts').createApp> | undefined;
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
  const health = await requestJson(`http://127.0.0.1:${port}/healthz`, undefined, 1000, false);
  if (!health.ok || child.exitCode !== null || child.signalCode !== null) throw new Error('Forge health check failed');
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
const useGo = process.env.FORGE_SERVER !== 'node';
function terminate(): void { child?.kill('SIGKILL'); server?.close(); lifecycleAgent.destroy(); process.exit(0); }
process.once('SIGTERM', terminate); process.once('SIGINT', terminate);
process.once('exit', () => child?.kill('SIGKILL'));
try {
  if (!useGo) throw new Error('Node server requested');
  port = await startBinary();
  process.stderr.write(`Forge Go server listening on ${port}\n`);
} catch (error) {
  await stopBinary();
  if (useGo) process.stderr.write(`Forge binary fallback: ${String(error)}\n`);
  const { createApp } = await import('./app.ts');
  server = createApp();
  await new Promise<void>(resolve => server!.listen(0, '0.0.0.0', resolve));
  port = (server.address() as { port: number }).port;
}
async function contact(path: string, body?: unknown): Promise<any> {
  return requestJson(endpoint + path, body);
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
lifecycleAgent.destroy();
await stopBinary();
process.exit(0);
