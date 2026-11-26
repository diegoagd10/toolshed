import type { Key } from '../keys/repository.js'
import type { AgentContext } from './context.js'
import { ApiError } from './errors.js'

export function authenticate(context: AgentContext, header: string | undefined): Key {
  const secret = /^Bearer (\S+)$/.exec(header ?? '')?.[1]
  const key = secret ? context.store.keys.authenticate(secret) : undefined
  if (key) return key
  const help = `send Authorization: Bearer <key>; see ${context.config.PUBLIC_URL}/llms.txt`
  throw new ApiError(401, 'unauthorized', `missing, unknown or revoked key; ${help}`, [
    ['WWW-Authenticate', 'Bearer'],
  ])
}
