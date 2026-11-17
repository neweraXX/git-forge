for (const [reader, writer] of [['native', 'native'], ['stream', 'native'], ['native', 'stream'], ['stream', 'stream']]) {
  process.env.FORGE_READER = reader; process.env.FORGE_WRITER = writer;
  console.log(`Transport mode: reader=${reader}, writer=${writer}`);
  await import(`./transport.ts?${reader}-${writer}`);
}
