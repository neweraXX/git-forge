import assert from 'node:assert/strict';
import { connect } from 'node:net';
import { createTransport } from '../transport.ts';
import { goServer } from './go-serve.ts';
process.env.MAKEFUN_SHOP_TOKEN = 'framing-test'; process.env.FORGE_LOGIN = 'alice';
const go = process.env.FORGE_TEST_GO ? await goServer() : undefined;
const server = go ? undefined : createTransport();
if (server) await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
const port = go?.port || (server!.address() as any).port;
async function exchange(parts: (Buffer | string)[], pauseRead = 0): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1'); socket.setNoDelay(true);
    socket.setTimeout(3000, () => { socket.destroy(); reject(new Error('Transport timeout')); });
    const chunks: Buffer[] = [];
    socket.on('data', data => chunks.push(data)); socket.on('error', reject);
    socket.on('end', () => resolve(Buffer.concat(chunks)));
    socket.on('connect', async () => {
      if (pauseRead) { socket.pause(); setTimeout(() => socket.resume(), pauseRead); }
      for (const part of parts) { socket.write(part); await new Promise(done => setTimeout(done, 1)); }
    });
  });
}
function responses(bytes: Buffer): { status: number; body: any }[] {
  const out = [];
  while (bytes.length) {
    const end = bytes.indexOf('\r\n\r\n'); assert.ok(end >= 0);
    const headers = bytes.toString('latin1', 0, end), status = Number(headers.slice(9, 12));
    const length = Number(/content-length: (\d+)/i.exec(headers)?.[1] || 0);
    assert.ok(bytes.length >= end + 4 + length);
    const text = bytes.toString('utf8', end + 4, end + 4 + length);
    out.push({ status, body: text ? JSON.parse(text) : null }); bytes = bytes.subarray(end + 4 + length);
  }
  return out;
}
const auth = 'Authorization: Bearer framing-test\r\n';
try {
  const body = Buffer.from(JSON.stringify({ name: 'framing-🌿' }));
  const headers = `POST /api/v3/user/repos HTTP/1.1\r\nHost: localhost\r\n${auth}Content-Length: ${body.length}\r\nConnection: close\r\n\r\n`;
  const fragmented = await exchange([headers.slice(0, 12), headers.slice(12, -1), headers.slice(-1), body.subarray(0, body.length - 3), body.subarray(body.length - 3)]);
  assert.equal(responses(fragmented)[0].body.name, 'framing-🌿');
  const chunkBody = JSON.stringify({ name: 'chunked' }), a = chunkBody.slice(0, 8), b = chunkBody.slice(8);
  const chunked = `POST /api/v3/user/repos HTTP/1.1\r\nHost: localhost\r\n${auth}Transfer-Encoding: chunked\r\n\r\n${a.length.toString(16)};extension=one\r\n${a}\r\n${b.length.toString(16)}\r\n${b}\r\n0\r\nTrailer: done\r\n\r\n`;
  const get = `GET /api/v3/repos/alice/chunked HTTP/1.1\r\nHost: localhost\r\n${auth}Connection: close\r\n\r\n`;
  const pipelined = responses(await exchange([chunked.slice(0, -8), chunked.slice(-8) + get]));
  assert.deepEqual(pipelined.map(r => r.status), [201, 200]);
  assert.equal(pipelined[0].body.id, pipelined[1].body.id);
  const repeated = `GET /healthz HTTP/1.1\r\nHost: localhost\r\n\r\n`;
  assert.deepEqual(responses(await exchange([repeated.repeat(100) + 'GET /healthz HTTP/1.0\r\n\r\n'])).map(r => r.status), Array(101).fill(200));
  const conflict = responses(await exchange([`POST /mcp HTTP/1.1\r\nContent-Length: 1\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n\r\n`]));
  assert.equal(conflict[0].status, 400);
  const duplicate = responses(await exchange([`POST /mcp HTTP/1.1\r\nContent-Length: 0\r\nContent-Length: 0\r\n\r\n`]));
  assert.equal(duplicate[0].status, 400);
  const issuePath = '/api/v3/repos/alice/chunked/issues';
  const large = JSON.stringify({ title: 'backpressure', body: 'x'.repeat(262144) });
  const create = `POST ${issuePath} HTTP/1.1\r\n${auth}Content-Length: ${large.length}\r\n\r\n${large}`;
  const issueGet = `GET ${issuePath}/1 HTTP/1.1\r\n${auth}\r\n`;
  const largeReplies = responses(await exchange([create + issueGet.repeat(64) + 'GET /healthz HTTP/1.0\r\n\r\n'], 100));
  assert.equal(largeReplies.length, 66);
  for (const reply of largeReplies.slice(0, -1)) assert.equal(reply.body.body.length, 262144);
  const patch = JSON.stringify({ title: 'updated' });
  const change = `PATCH ${issuePath}/1 HTTP/1.1\r\n${auth}Content-Length: ${patch.length}\r\n\r\n${patch}`;
  const wrong = issueGet.replace('framing-test', 'wrong');
  const changes = responses(await exchange([issueGet, issueGet, change, issueGet, issueGet, wrong, issueGet, 'GET /healthz HTTP/1.0\r\n\r\n']));
  assert.equal(changes[0].body.title, 'backpressure');
  assert.equal(changes[1].body.title, 'backpressure');
  assert.equal(changes[3].body.title, 'updated');
  assert.equal(changes[4].body.title, 'updated');
  assert.equal(changes[5].status, 401);
  assert.equal(changes[6].body.title, 'updated');
  console.log('Transport tests passed: fragmentation, chunked/trailers, pipelining, invalid framing, 16 MiB backpressure, GET mutation/auth invalidation');
} finally { server?.close(); await go?.stop(); }
