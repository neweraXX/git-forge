import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const runtime = ['main', 'app', 'router', 'transport', 'reader', 'writer', 'store', 'rest', 'git', 'inflate', 'graphql', 'mcp'];
for (const mode of ['binary', 'missing', 'unexecutable', 'invalid-port', 'dead-port', 'timeout', 'node']) {
  const directory = mkdtempSync('/tmp/forge-launch-test-');
  // Successful Go startup must not even load the fallback's application modules.
  for (const name of mode === 'binary' ? ['main'] : runtime) cpSync(`/bot/${name}.ts`, join(directory, `${name}.ts`));
  mkdirSync(join(directory, 'bin'));
  const target = join(directory, 'bin', `forge-${process.arch === 'arm64' ? 'arm64' : 'x64'}`);
  if (mode === 'binary' || mode === 'node') cpSync(`/bot/bin/forge-${process.arch === 'arm64' ? 'arm64' : 'x64'}`, target);
  if (mode === 'unexecutable') writeFileSync(target, '#!/no-such-forge-interpreter\n');
  if (mode === 'invalid-port') writeFileSync(target, '#!/bin/sh\necho invalid\nexec sleep 30\n');
  if (mode === 'dead-port') writeFileSync(target, '#!/bin/sh\necho 1\nexec sleep 30\n');
  if (mode === 'timeout') writeFileSync(target, '#!/bin/sh\nexec sleep 30\n');
  let port = 0, checked = false, checkError: unknown;
  const lifecycle = createServer(async (request, response) => {
    response.setHeader('content-type', 'application/json');
    if (request.url === '/register') {
      let text = ''; for await (const chunk of request) text += chunk;
      port = JSON.parse(text).port;
      try {
        assert.deepEqual(await (await fetch(`http://127.0.0.1:${port}/healthz`)).json(), { ok: true });
        assert.equal((await fetch(`http://127.0.0.1:${port}/api/v3/user`)).status, 401);
        const reply = await fetch(`http://127.0.0.1:${port}/api/v3/user`, { headers: { authorization: 'Bearer launcher-test' } });
        assert.equal((await reply.json()).login, 'forge');
        if (mode === 'binary') {
          const cpu = () => { const fields = readFileSync(`/proc/${child.pid}/stat`, 'utf8').split(' '); return (Number(fields[13]) + Number(fields[14])) * 10; };
          const before = cpu();
          for (let index = 0; index < 300; index++) {
            const response = await fetch(`http://127.0.0.1:${port}/api/v3/user`, { headers: { authorization: 'Bearer launcher-test' } });
            assert.equal((await response.json()).login, 'forge');
          }
          const elapsedCpu = cpu() - before;
          assert.ok(elapsedCpu <= 20, `Node main used ${elapsedCpu} ms CPU while Go served`);
          console.log(`Node main idle while Go served 300 requests: ${elapsedCpu} ms CPU (10 ms ticks)`);
        }
        checked = true;
      } catch (error) { checkError = error; }
      response.end('{}');
    } else response.end(JSON.stringify({ done: checked || !!checkError }));
  });
  await new Promise<void>(resolve => lifecycle.listen(0, '127.0.0.1', resolve));
  const started = performance.now();
  const childEnv = { ...process.env, MAKEFUN_ENV_URL: `http://127.0.0.1:${(lifecycle.address() as any).port}`, MAKEFUN_SHOP_TOKEN: 'launcher-test', FORGE_LOGIN: '' };
  delete childEnv.FORGE_SERVER;
  if (mode === 'node') childEnv.FORGE_SERVER = 'node';
  const child = spawn(process.execPath, [join(directory, 'main.ts')], { env: childEnv, stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = ''; child.stderr.on('data', chunk => stderr += chunk);
  const timeout = setTimeout(() => child.kill('SIGKILL'), 15000);
  try {
    const code = await new Promise<number | null>((resolve, reject) => { child.once('exit', resolve); child.once('error', reject); });
    assert.equal(code, 0, stderr); if (checkError) throw checkError; assert.ok(checked);
    assert.equal(stderr.includes('Forge binary fallback:'), mode !== 'binary' && mode !== 'node', stderr);
    assert.equal(stderr.includes('Forge Go server listening on '), mode === 'binary', stderr);
    if (mode === 'timeout') assert.ok(performance.now() - started >= 4900);
    await assert.rejects(fetch(`http://127.0.0.1:${port}/healthz`), 'server must stop when lifecycle exits');
    console.log(`Launcher passed: ${mode}`);
  } finally { clearTimeout(timeout); child.kill('SIGKILL'); lifecycle.closeAllConnections(); lifecycle.close(); rmSync(directory, { recursive: true, force: true }); }
}
