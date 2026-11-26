import { z } from 'zod'

export class ConfigError extends Error {
  override name = 'ConfigError'
}

const required = z.string('is required')
  .min(1, { error: 'is required', abort: true })

const origin = required.transform((value, ctx) => {
  const url = URL.parse(value)
  if (url && /^https?:$/.test(url.protocol) && url.href === `${url.origin}/`) return url.origin
  ctx.addIssue('must be an http(s) origin without path, query or credentials')
  return z.NEVER
})

const port = z.coerce.number('must be a port from 0 to 65535')
  .int('must be a port from 0 to 65535')
  .min(0, 'must be a port from 0 to 65535')
  .max(65535, 'must be a port from 0 to 65535')

const schema = z.object({
  OWNER_PASSWORD: required,
  PUBLIC_URL: origin,
  ADMIN_URL: origin,
  DATA: z.string()
    .min(1, 'must not be empty')
    .default('./data'),
  AGENT_PORT: port.default(4400),
  ADMIN_PORT: port.default(4401),
})

export type Config = z.output<typeof schema>

export type Environment = {
  OWNER_PASSWORD?: string
  PUBLIC_URL?: string
  ADMIN_URL?: string
  DATA?: string
  AGENT_PORT?: string
  ADMIN_PORT?: string
}

export function parseConfig(env: Environment): Config {
  const result = schema.safeParse(env)
  if (result.success) return result.data
  const problems = result.error.issues.map((issue) => `${issue.path.join('.')} ${issue.message}`)
  throw new ConfigError(`Invalid configuration: ${problems.join('; ')}`)
}
