// Counts wrong passwords in a sliding window. Past the limit, every attempt is refused,
// the right password included, until the oldest failure leaves the window.
export class LoginLimiter {
  readonly #windowMs: number
  readonly #max: number
  readonly #now: () => number
  #failures: number[] = []

  constructor(windowMs = 60_000, max = 5, now = Date.now) {
    this.#windowMs = windowMs
    this.#max = max
    this.#now = now
  }

  // Seconds until the next attempt is allowed, or 0 when it is allowed now.
  wait() {
    const now = this.#now()
    this.#failures = this.#failures.filter((at) => at > now - this.#windowMs)
    if (this.#failures.length < this.#max) return 0
    return Math.ceil((Number(this.#failures[0]) + this.#windowMs - now) / 1000)
  }

  fail() {
    this.#failures.push(this.#now())
  }
}
