process.env.FORGE_GO_HTTP = 'epoll';
process.env.FORGE_TEST_GO = '1';
await import('./transport.ts');
