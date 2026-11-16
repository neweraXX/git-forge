import { createApp } from '../app.ts';
const server = createApp();
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
process.send?.({ port: (server.address() as any).port });
process.on('message', () => { server.close(); process.exit(0); });
