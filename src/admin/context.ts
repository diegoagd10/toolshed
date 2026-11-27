import { createHash, timingSafeEqual } from 'node:crypto'
import type { Config } from '../config.js'
import type { Pairs } from '../pair/pairs.js'
import { SlidingWindow } from '../limits/window.js'
import type { Store } from '../store/repository.js'
import type { Created, Notice } from './pages.js'

const sessionMs = 30 * 24 * 60 * 60 * 1000

function digest(text: string) {
  return createHash('sha256')
    .update(text)
    .digest()
}

// Sessions are stored, so a restart keeps the owner signed in. A new key's secret and notices
// live in memory only.
export class AdminContext {
  readonly config: Config
  readonly store: Store
  // Five wrong passwords in a minute block the next attempt, the right password included.
  readonly limiter = new SlidingWindow(60_000, 5)
  // Six wrong pairing codes in a minute block the next attempt, the right code included.
  readonly pairLimiter = new SlidingWindow(60_000, 6)
  readonly pairs: Pairs
  // A new key's secret, kept until the next page view of the session that created it.
  readonly #created = new Map<string, Created>()
  readonly #notices = new Map<string, Notice>()

  constructor(config: Config, store: Store, pairs: Pairs) {
    this.config = config
    this.store = store
    this.pairs = pairs
  }

  passwordMatches(password: string) {
    return timingSafeEqual(digest(password), digest(this.config.OWNER_PASSWORD))
  }

  openSession() {
    const token = this.store.sessions.open(sessionMs)
    return { token, maxAge: sessionMs / 1000 }
  }

  validSession(token: string) {
    return this.store.sessions.valid(token)
  }

  closeSession(token: string) {
    this.store.sessions.close(token)
    this.#created.delete(token)
    this.#notices.delete(token)
  }

  remember(token: string, created: Created) {
    this.#created.set(token, created)
  }

  takeCreated(token: string) {
    const created = this.#created.get(token)
    this.#created.delete(token)
    return created
  }

  notify(token: string, notice: Notice) {
    this.#notices.set(token, notice)
  }

  takeNotice(token: string) {
    const notice = this.#notices.get(token)
    this.#notices.delete(token)
    return notice
  }
}
