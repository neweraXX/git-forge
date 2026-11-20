// Materialize 0c1ae6f's diagnostic-only baseline binary under test/ before this
// run; remove it afterwards and before full grades (it is intentionally untracked).
process.env.REPEATS = '1';
const versions = ['before', 'after', 'after', 'before', 'before', 'after'];
const rows: any[] = [];
const output = console.log;
try {
  for (let pair = 0; pair < versions.length; pair++) {
    const version = versions[pair];
    process.env.FORGE_BINARY = version === 'before'
      ? `/bot/test/forge-baseline-${process.arch === 'arm64' ? 'arm64' : 'x64'}`
      : `/bot/bin/forge-${process.arch === 'arm64' ? 'arm64' : 'x64'}`;
    console.log = (line: string) => {
      const row = JSON.parse(line);
      if (row.median) rows.push({ version, pair, ...row });
      output(JSON.stringify({ version, pair, ...row }));
    };
    await import(`./go-workload-metrics.ts?paired=${pair}`);
  }
} finally { console.log = output; delete process.env.FORGE_BINARY; }
const result: any = {};
for (const version of ['before', 'after']) {
  result[version] = {};
  for (const name of ['push', 'clone', 'read', 'write']) {
    const samples = rows.filter(r => r.version === version && r.workload === name);
    result[version][name] = Object.fromEntries(Object.keys(samples[0].median).map(key => [key, samples.map(r => r.median[key]).sort((a, b) => a - b)[1]]));
  }
}
output('PAIR_SUMMARY ' + JSON.stringify(result));
