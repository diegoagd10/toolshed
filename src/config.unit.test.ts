// unit-test-reason: the parsed values are not visible from outside until a feature uses them.
import assert from 'node:assert/strict'
import { test } from 'vite-plus/test'
import { parseConfig } from './config.js'

const complete = {
  OWNER_PASSWORD: 'correct horse',
  PUBLIC_URL: 'https://tools.example.com',
  ADMIN_URL: 'http://admin.lan:8080',
}

test('a complete configuration parses and DATA defaults to ./data', () => {
  assert.deepEqual(parseConfig(complete), { ...complete, DATA: './data' })
  assert.equal(parseConfig({ ...complete, DATA: '/srv/data' }).DATA, '/srv/data')
})

for (const name of ['PUBLIC_URL', 'ADMIN_URL'] as const) {
  test(`${name} drops the trailing slash and keeps the port`, () => {
    const config = parseConfig({ ...complete, [name]: 'https://tools.example.com:8443/' })
    assert.equal(config[name], 'https://tools.example.com:8443')
  })
}
