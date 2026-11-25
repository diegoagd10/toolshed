import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { onTestFinished, test } from 'vite-plus/test'

const root = join(import.meta.dirname, '..')

async function lint(file: string, code: string, ...flags: string[]) {
  const dir = await mkdtemp(join(tmpdir(), 'toolshed-lint-'))
  onTestFinished(() => rm(dir, { recursive: true }))
  for (const name of ['vite.config.ts', 'tsconfig.json', 'package.json', 'lint/plugin.ts']) {
    await cp(join(root, name), join(dir, name))
  }
  await symlink(join(root, 'node_modules'), join(dir, 'node_modules'))
  const path = join(dir, file)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, code)
  const vp = join(root, 'node_modules/.bin/vp')
  const child = spawn(vp, ['lint', '--format=unix', ...flags, file], { cwd: dir })
  let output = ''
  child.stdout.on('data', (chunk) => {
    output += chunk
  })
  child.stderr.on('data', (chunk) => {
    output += chunk
  })
  const [status] = await once(child, 'close')
  return { status, output, code: await readFile(path, 'utf8') }
}

function fails(rule: string, file: string, code: string) {
  test(`${rule} fails on ${file}: ${JSON.stringify(code)}`, { timeout: 20_000 }, async () => {
    const { status, output } = await lint(file, code)
    assert.equal(status, 1, output)
    assert.ok(output.includes(rule), output)
  })
}

function passes(file: string, code: string) {
  test(`passes ${file}: ${JSON.stringify(code)}`, { timeout: 20_000 }, async () => {
    const { status, output } = await lint(file, code)
    assert.equal(status, 0, output)
  })
}

const zod = "import { z } from 'zod'\n"
const controller = "import { Controller } from '@nestjs/common'\n\n@Controller()\nexport class A {}\n"
const module = "import { Module } from '@nestjs/common'\n\n@Module({})\nexport class A {}\n"
const aliased = controller.replace('{ Controller }', '{ Controller as C }')
  .replace('@Controller()', '@C()')
const namespaced = "import * as nest from '@nestjs/common'\n\n@nest.Controller()\nexport class A {}\n"
const chained = `${zod}export const a = z.string('x')\n  .min(1, { error: 'x', abort: true })\n`
const runner = "import { test } from 'vite-plus/test'\n\ntest('x', () => {})\n"

test('fixing splits a chain and drops semicolons', { timeout: 20_000 }, async () => {
  const source = `${zod}export const a = z.string('x').min(1, { error: 'x', abort: true });\n`
  let fixed = source
  for (let pass = 0; pass < 2; pass++) {
    fixed = (await lint('src/a.ts', fixed, '--fix')).code
  }
  assert.equal(fixed, chained)
})

fails('newline-per-chained-call', 'src/a.ts', chained.replace('\n  .min', '.min'))
passes('src/a.ts', chained)
fails('semi', 'src/a.ts', 'export const a = 1;\n')
fails('member-delimiter-style', 'src/a.ts', 'export type A = { a: 1; b: 2 }\n')

fails('no-record', 'src/a.ts', 'export type A = Record<string, string>\n')
fails('no-record', 'src/a.ts', 'export type A = { [key: string]: string }\n')
passes('src/a.ts', 'export class A {\n  name = 1\n}\n')

fails('controller-file', 'src/app.ts', controller)
fails('controller-file', 'src/a/b/controller.ts', controller)
fails('controller-file', 'src/a/modules.ts', aliased)
fails('controller-file', 'src/app.ts', namespaced)
passes('src/agent/controller.ts', controller)

fails('module-file', 'src/app.ts', module)
fails('module-file', 'src/agent/module.ts', module)
passes('src/agent/modules.ts', module)

fails('integration-tests', 'src/a.test.ts', runner)
fails('integration-tests', 'src/a.unit.test.ts', runner)
fails('integration-tests', 'src/a.unit.test.ts', `// unit-test-reason:\n${runner}`)
fails('integration-tests', 'src/a.ts', runner)
fails('integration-tests', 'src/a.integration.test.ts', `import './config.js'\n${runner}`)
fails('integration-tests', 'src/a.integration.test.ts', runner.replace('test }', 'test, vi }') + "vi.mock('zod')\n")
passes('src/a.unit.test.ts', `// unit-test-reason: no route reaches the retry.\n${runner}`)
passes('src/a.integration.test.ts', runner)
