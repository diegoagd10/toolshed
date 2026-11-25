import assert from 'node:assert/strict';
import { once } from 'node:events';
import { type AddressInfo, createServer } from 'node:net';
import { test } from 'node:test';
import { start } from './app.js';
import { parseConfig } from './config.js';

const config = parseConfig({
  OWNER_PASSWORD: 'test',
  PUBLIC_URL: 'https://tools.example.com',
  ADMIN_URL: 'http://admin.lan',
});

async function occupy(port: number) {
  const server = createServer();
  server.listen(port);
  await once(server, 'listening');
  return {
    port: (server.address() as AddressInfo).port,
    async [Symbol.asyncDispose]() {
      server.close();
      await once(server, 'close');
    },
  };
}

test('both ports answer health and 404 anything else', async (t) => {
  const running = await start(config, { agent: 0, admin: 0 });
  t.after(running.close);
  assert.notEqual(running.ports.agent, running.ports.admin);
  for (const port of [running.ports.agent, running.ports.admin]) {
    const health = await fetch(`http://localhost:${port}/health`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { ok: true });
    assert.equal(health.headers.get('x-powered-by'), null);
    for (const path of ['/', '/keys', '/health/x']) {
      assert.equal((await fetch(`http://localhost:${port}${path}`)).status, 404);
    }
  }
});

test('close frees both ports', async () => {
  const { ports, close } = await start(config, { agent: 0, admin: 0 });
  await close();
  await using _agent = await occupy(ports.agent);
  await using _admin = await occupy(ports.admin);
});

test('a taken admin port rejects and leaves the agent port free', async () => {
  const free = await occupy(0);
  await free[Symbol.asyncDispose]();
  await using taken = await occupy(0);
  await assert.rejects(start(config, { agent: free.port, admin: taken.port }), {
    code: 'EADDRINUSE',
  });
  await using _agent = await occupy(free.port);
});

test('a taken agent port rejects and leaves the admin port free', async () => {
  const free = await occupy(0);
  await free[Symbol.asyncDispose]();
  await using taken = await occupy(0);
  await assert.rejects(start(config, { agent: taken.port, admin: free.port }), {
    code: 'EADDRINUSE',
  });
  await using _admin = await occupy(free.port);
});
