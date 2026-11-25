import assert from 'node:assert/strict';
import { test } from 'vite-plus/test';
import { inspect } from 'node:util';
import { ConfigError, parseConfig } from './config.js';

const complete = {
  OWNER_PASSWORD: 'correct horse',
  PUBLIC_URL: 'https://tools.example.com',
  ADMIN_URL: 'http://admin.lan:8080',
};
const required = ['OWNER_PASSWORD', 'PUBLIC_URL', 'ADMIN_URL'] as const;

function configError(env: Record<string, string | undefined>): ConfigError {
  try {
    parseConfig(env);
  } catch (error) {
    assert.ok(error instanceof ConfigError);
    return error;
  }
  assert.fail('expected a ConfigError');
}

function named(error: ConfigError) {
  return [...required, 'DATA'].filter((name) => error.message.includes(name));
}

test('a complete configuration parses and DATA defaults to ./data', () => {
  assert.deepEqual(parseConfig(complete), { ...complete, DATA: './data' });
  assert.equal(parseConfig({ ...complete, DATA: '/srv/data' }).DATA, '/srv/data');
});

for (const name of required) {
  for (const [label, value] of [
    ['missing', undefined],
    ['empty', ''],
  ] as const) {
    test(`${label} ${name} is the only variable named`, () => {
      assert.deepEqual(named(configError({ ...complete, [name]: value })), [name]);
    });
  }
}

test('an empty DATA is named', () => {
  assert.deepEqual(named(configError({ ...complete, DATA: '' })), ['DATA']);
});

test('all bad variables are named in one error', () => {
  assert.deepEqual(named(configError({})), [...required]);
  assert.deepEqual(named(configError({ PUBLIC_URL: 'nope', ADMIN_URL: 'nope', DATA: '' })), [
    ...required,
    'DATA',
  ]);
});

const badUrls = [
  'not a url',
  'tools.example.com',
  'ftp://tools.example.com',
  'javascript:alert(1)',
  'file:///etc/passwd',
  'https://tools.example.com/path',
  'https://tools.example.com//',
  'https://tools.example.com?q=1',
  'https://tools.example.com/?',
  'https://tools.example.com/#top',
  'https://user@tools.example.com',
  'https://user:pass@tools.example.com',
];
for (const name of ['PUBLIC_URL', 'ADMIN_URL'] as const) {
  for (const url of badUrls) {
    test(`${name} rejects ${url}`, () => {
      assert.deepEqual(named(configError({ ...complete, [name]: url })), [name]);
    });
  }

  test(`${name} drops the trailing slash and keeps the port`, () => {
    const config = parseConfig({ ...complete, [name]: 'https://tools.example.com:8443/' });
    assert.equal(config[name], 'https://tools.example.com:8443');
  });
}

test('values never appear anywhere in the error', () => {
  const error = configError({
    OWNER_PASSWORD: 'sekret-owner',
    PUBLIC_URL: 'https://user:sekret-public@tools.example.com',
    ADMIN_URL: 'sekret-admin',
  });
  assert.deepEqual(named(error), ['PUBLIC_URL', 'ADMIN_URL']);
  assert.doesNotMatch(`${error.stack} ${inspect(error)}`, /sekret|tools\.example/);
});
