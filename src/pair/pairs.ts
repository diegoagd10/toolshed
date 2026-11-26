import { randomBytes, randomInt } from 'node:crypto'

// No 0, O, 1, I or L, so the owner cannot misread the code.
const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
const codeLength = 8

type Waiting = { wake: (() => void)[] }
export type Pair =
  | Waiting & { state: 'pending', code: string, agent: string, expiresAt: number }
  | Waiting & { state: 'approved', agent: string, expiresAt: number }

export function normalized(code: string) {
  return code.toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
}

// Pairing requests live in memory for 10 minutes. The agent holds pair_id; the owner types code.
export class Pairs {
  readonly maxPending: number
  readonly #lifetimeMs: number
  readonly #now: () => number
  #pairs = new Map<string, Pair>()

  constructor(maxPending = 20, lifetimeMs = 10 * 60_000, now = Date.now) {
    this.maxPending = maxPending
    this.#lifetimeMs = lifetimeMs
    this.#now = now
  }

  #live() {
    const now = this.#now()
    this.#pairs = new Map([...this.#pairs].filter(([, pair]) => pair.expiresAt > now))
    return this.#pairs
  }

  // undefined when maxPending agents are already waiting for the owner.
  start(agent: string) {
    const pairs = this.#live()
    if ([...pairs.values()].filter((pair) => pair.state === 'pending').length >= this.maxPending) return undefined
    const id = `pair_${randomBytes(24)
      .toString('base64url')}`
    const code = Array.from({ length: codeLength }, () => alphabet[randomInt(alphabet.length)])
      .join('')
    const expiresAt = this.#now() + this.#lifetimeMs
    pairs.set(id, { state: 'pending', code, agent, expiresAt, wake: [] })
    return { id, code: `${code.slice(0, 4)}-${code.slice(4)}`, expiresAt }
  }

  // The agent's name, or undefined when no pending pair has this code.
  approve(code: string) {
    const typed = normalized(code)
    for (const [id, pair] of this.#live()) {
      if (pair.state !== 'pending' || pair.code !== typed) continue
      this.#pairs.set(id, { state: 'approved', agent: pair.agent, expiresAt: pair.expiresAt, wake: [] })
      for (const wake of pair.wake) wake()
      return pair.agent
    }
    return undefined
  }

  // Waits up to waitMs for the owner. An approved pair is handed out once and then forgotten.
  async claim(id: string, waitMs: number): Promise<'unknown' | 'pending' | { agent: string }> {
    const waiting = this.#live()
      .get(id)
    if (!waiting) return 'unknown'
    if (waiting.state === 'pending') {
      let timer: NodeJS.Timeout | undefined
      await new Promise<void>((done) => {
        waiting.wake.push(done)
        // unref: a request still waiting must not keep the process alive at shutdown.
        timer = setTimeout(done, waitMs)
          .unref()
      })
      clearTimeout(timer)
    }
    // Nothing awaits between this check and the delete, so two claims cannot both win.
    const pair = this.#live()
      .get(id)
    if (!pair) return 'unknown'
    if (pair.state === 'pending') return 'pending'
    this.#pairs.delete(id)
    return { agent: pair.agent }
  }
}
