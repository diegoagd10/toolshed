import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import type { Config } from '../config.js'
import type { Store } from '../store/repository.js'
import { LoginLimiter } from './limiter.js'
import type { Created } from './pages.js'

const sessionMs = 30 * 24 * 60 * 60 * 1000

function digest(text: string) {
  return createHash('sha256')
    .update(text)
    .digest()
}

// Sessions live in memory: a restart signs the owner out, and nothing about them reaches the disk.
export class AdminContext {
  readonly config: Config
  readonly store: Store
  readonly limiter = new LoginLimiter()
  readonly #sessions = new Map<string, number>()
  // A new key's secret, kept until the next page view of the session that created it.
  readonly #created = new Map<string, Created>()

  constructor(config: Config, store: Store) {
    this.config = config
    this.store = store
  }

  passwordMatches(password: string) {
    return timingSafeEqual(digest(password), digest(this.config.OWNER_PASSWORD))
  }

  openSession() {
    const token = randomBytes(32)
      .toString('base64url')
    this.#sessions.set(token, Date.now() + sessionMs)
    return { token, maxAge: sessionMs / 1000 }
  }

  validSession(token: string) {
    return (this.#sessions.get(token) ?? 0) > Date.now()
  }

  closeSession(token: string) {
    this.#sessions.delete(token)
    this.#created.delete(token)
  }

  remember(token: string, created: Created) {
    this.#created.set(token, created)
  }

  takeCreated(token: string) {
    const created = this.#created.get(token)
    this.#created.delete(token)
    return created
  }
}
