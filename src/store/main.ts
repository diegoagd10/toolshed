import { createReadStream } from 'node:fs'
import { createInterface } from 'node:readline'
import { z } from 'zod'
import type { Call } from '../calls/repository.js'
import { StoreError } from './error.js'
import { openStore, type Store } from './repository.js'

const callSchema: z.ZodType<Call> = z.strictObject({
  at: z.string(),
  keyId: z.string(),
  tool: z.string(),
  via: z.enum(['rest', 'mcp']),
  ms: z.int(),
  error: z.string()
    .nullable(),
})

const commandSchema = z.discriminatedUnion('do', [
  z.strictObject({ do: z.literal('key.create'), name: z.string() }),
  z.strictObject({ do: z.literal('key.authenticate'), secret: z.string() }),
  z.strictObject({ do: z.literal('key.revoke'), id: z.string() }),
  z.strictObject({ do: z.literal('key.list') }),
  z.strictObject({ do: z.literal('call.record'), call: callSchema }),
  z.strictObject({ do: z.literal('call.list'), limit: z.int() }),
  z.strictObject({ do: z.literal('file.save'), name: z.string(), mime: z.string(), path: z.string() }),
  z.strictObject({ do: z.literal('file.find'), id: z.string() }),
  z.strictObject({
    do: z.literal('link.sign'),
    method: z.string(),
    id: z.string(),
    lifetimeMs: z.int(),
  }),
  z.strictObject({
    do: z.literal('link.verify'),
    method: z.string(),
    id: z.string(),
    expiresAt: z.number(),
    signature: z.string(),
  }),
])

export type Command = z.output<typeof commandSchema>

async function run(store: Store, command: Command): Promise<unknown> {
  switch (command.do) {
    case 'key.create': return store.keys.create(command.name)
    case 'key.authenticate': return store.keys.authenticate(command.secret) ?? null
    case 'key.revoke': return store.keys.revoke(command.id) ?? null
    case 'key.list': return store.keys.list()
    case 'call.record': return store.calls.record(command.call) ?? null
    case 'call.list': return store.calls.recent(command.limit)
    case 'file.save': return store.files.save(command.name, command.mime, createReadStream(command.path))
    case 'file.find': return store.files.find(command.id)
    case 'link.sign': return store.links.sign(command, command.lifetimeMs)
    case 'link.verify': return store.links.verify(command)
  }
}

async function answer(store: Store, line: string) {
  try {
    const command = commandSchema.parse(JSON.parse(line))
    return { result: await run(store, command) }
  } catch (error) {
    return { error: error instanceof StoreError ? error.code : String(error) }
  }
}

const [dataDir = './data'] = process.argv.slice(2)
const store = openStore(dataDir)
for await (const line of createInterface({ input: process.stdin })) {
  process.stdout.write(`${JSON.stringify(await answer(store, line))}\n`)
}
store.close()
