import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { onTestFinished, test } from 'vite-plus/test';
import { setTimeout as sleep } from 'node:timers/promises';

const env = {
  OWNER_PASSWORD: 'sekret-owner',
  PUBLIC_URL: 'https://tools.example.com',
  ADMIN_URL: 'http://admin.lan',
};

function run(env: Record<string, string>) {
  const child = spawn(process.execPath, [join(import.meta.dirname, '../dist/main.js')], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 15_000,
    killSignal: 'SIGKILL',
  });
  let output = '';
  child.stdout.on('data', (chunk) => {
    output += chunk;
  });
  child.stderr.on('data', (chunk) => {
    output += chunk;
  });
  const exited = once(child, 'close').then(([code, signal]) => ({ code, signal, output }));
  return { child, exited };
}

async function healthy(port: number, exited: Promise<{ output: string }>) {
  let stopped: string | undefined;
  void exited.then(({ output }) => {
    stopped = output;
  });
  for (let attempt = 0; attempt < 100; attempt++) {
    assert.equal(stopped, undefined, `main exited early: ${stopped}`);
    const status = await fetch(`http://localhost:${port}/health`).then(
      (response) => response.status,
      () => undefined,
    );
    if (status === 200) return;
    await sleep(100);
  }
  assert.fail(`port ${port} never became healthy`);
}

test('a bad configuration exits non-zero with one line and no values', async () => {
  const { exited } = run({ ...env, PUBLIC_URL: '', ADMIN_URL: 'sekret-admin' });
  const { code, output } = await exited;
  assert.equal(code, 1);
  assert.match(output, /^.*PUBLIC_URL.*ADMIN_URL.*\n$/);
  assert.doesNotMatch(output, /sekret/);
});

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  test(`${signal} exits 0`, async () => {
    const { child, exited } = run(env);
    onTestFinished(() => void child.kill('SIGKILL'));
    await healthy(4400, exited);
    await healthy(4401, exited);
    child.kill(signal);
    assert.deepEqual(await exited, { code: 0, signal: null, output: '' });
  });
}

test('a taken port exits non-zero and names it', async () => {
  const server = createServer();
  server.listen(4401);
  await once(server, 'listening');
  onTestFinished(() => void server.close());
  const { code, output } = await run(env).exited;
  assert.equal(code, 1);
  assert.match(output, /EADDRINUSE.*4401/);
  assert.doesNotMatch(output, /sekret|\n\s+at /);
});
