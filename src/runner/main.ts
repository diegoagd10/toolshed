import { createInterface } from 'node:readline'
import { z } from 'zod'
import { jobSchema } from '../tools/job.js'
import { defaultLimits, Runner } from './runner.js'

const limitsSchema = z.strictObject({
  maxRssBytes: z.int()
    .positive(),
  timeoutMs: z.int()
    .positive(),
  running: z.int()
    .positive(),
  waiting: z.int()
    .nonnegative(),
})
  .partial()

const commandSchema = z.union([
  z.strictObject({ id: z.int(), job: jobSchema }),
  z.strictObject({ id: z.int(), ping: z.literal(true) }),
])

export type Command = z.output<typeof commandSchema>

const limits = limitsSchema.parse(JSON.parse(process.argv[2] ?? '{}'))
const runner = new Runner({ ...defaultLimits, ...limits })

function reply(answer: object) {
  process.stdout.write(`${JSON.stringify(answer)}\n`)
}

// One command per line. Jobs answer when they finish, so answers can come out of order.
for await (const line of createInterface({ input: process.stdin })) {
  const command = commandSchema.parse(JSON.parse(line))
  if ('ping' in command) reply({ id: command.id, pong: true })
  else void runner.run(command.job)
    .then((result) => reply({ id: command.id, result }))
}
