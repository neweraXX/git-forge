// Development runner; the competition kit is mounted read-only beside /bot by ./dock.
import { createApp } from '../app.ts';
import { suiteChecks, createGitFixture } from '/kit/program/env/src/main.ts';
import { configureGraphQLGit } from '/kit/program/env/src/checks-graphql.ts';
import { buildScenario } from '/kit/program/env/src/wire.ts';
process.env.MAKEFUN_SHOP_TOKEN = 'local-test-token';
const server = createApp();
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
const baseUrl = `http://127.0.0.1:${(server.address() as any).port}`;
const token = process.env.MAKEFUN_SHOP_TOKEN;
configureGraphQLGit(createGitFixture({ baseUrl, token }));
let passed = 0;
for (const check of suiteChecks()) {
  const timeoutMs = check.timeoutMs || 8000;
  const result = await check.fn({ baseUrl, token, scenario: buildScenario(), timeoutMs, deadlineMs: performance.now() + timeoutMs, signal: AbortSignal.timeout(timeoutMs), log: () => {} });
  if (result.ok) passed++;
  console.log(`${result.ok ? 'PASS' : 'FAIL'} ${check.id}: ${result.detail || ''}`);
}
console.log(`Passed ${passed}/120`);
server.close();
