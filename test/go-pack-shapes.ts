import { runBenchmark } from '/kit/program/env/src/bench.ts';
import { inflateAt } from '/kit/program/env/src/git-client.ts';
import { goServer } from './go-serve.ts';
const server = await goServer({ MAKEFUN_SHOP_TOKEN: 'shapes' });
const realFetch = globalThis.fetch;
const counts: Record<string, number> = {};
globalThis.fetch = async (url: any, options: any) => {
  if (String(url).endsWith('/git-receive-pack')) {
    const body = Buffer.from(options.body), start = body.indexOf('PACK');
    if (start >= 0) {
      const pack = body.subarray(start); let pos = 12;
      for (let n = pack.readUInt32BE(8); n > 0; n--) {
        let b = pack[pos++]; const type = b >>> 4 & 7;
        while (b & 128) b = pack[pos++];
        if (type === 7) pos += 20;
        else if (type === 6) { do { b = pack[pos++]; } while (b & 128); }
        const shape = `${type}:${['stored', 'fixed', 'dynamic', 'invalid'][pack[pos + 2] >>> 1 & 3]}`;
        counts[shape] = (counts[shape] || 0) + 1;
        pos = inflateAt(pack, pos).next;
      }
    }
  }
  return realFetch(url, options);
};
try {
  const result = await runBenchmark({ baseUrl: `http://127.0.0.1:${server.port}`, token: 'shapes', workloads: ['push'], rounds: 1 });
  console.log(JSON.stringify({ counts, result: result.workloads }));
} finally { globalThis.fetch = realFetch; await server.stop(); }
