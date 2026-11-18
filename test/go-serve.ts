import { spawn } from 'node:child_process';
export async function goServer(env: Record<string, string> = {}) {
  const child = spawn(`/bot/bin/forge-${process.arch === 'arm64' ? 'arm64' : 'x64'}`, [], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'inherit'] });
  const port = await new Promise<number>((resolve, reject) => {
    let output = '';
    const timeout = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Go startup timeout')); }, 5000);
    child.stdout.on('data', chunk => { output += chunk; if (output.includes('\n')) { clearTimeout(timeout); resolve(Number(output.split('\n')[0])); } });
    child.once('error', error => { clearTimeout(timeout); reject(error); });
    child.once('exit', code => { clearTimeout(timeout); reject(new Error(`Go exited: ${code}`)); });
  });
  return { child, port, stop: async () => { const end = new Promise(resolve => child.once('exit', resolve)); child.kill('SIGKILL'); await end; } };
}
