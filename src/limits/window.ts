// Counts events per name, such as a key id or an IP, in a sliding window. Past the limit, every
// attempt under that name is refused until its oldest event leaves the window.
export class SlidingWindow {
  readonly windowMs: number
  readonly max: number
  readonly #now: () => number
  // Each name's events, with names in the order of their last event. Names whose last event left
  // the window are dropped from the front, so many IPs cannot grow the map.
  readonly #events: Map<string, number[]>

  constructor(windowMs: number, max: number, now = Date.now, events = new Map<string, number[]>()) {
    this.windowMs = windowMs
    this.max = max
    this.#now = now
    this.#events = events
  }

  // Seconds until the next event under this name is allowed, or 0 when it is allowed now.
  wait(name = '') {
    const now = this.#now()
    this.#forget(now)
    const events = this.#recent(name, now)
    if (events.length < this.max) return 0
    return Math.ceil((Number(events[0]) + this.windowMs - now) / 1000)
  }

  add(name = '') {
    const now = this.#now()
    const events = [...this.#recent(name, now), now]
    this.#events.delete(name)
    this.#events.set(name, events)
  }

  // Counts the event when it is allowed. Returns the seconds to wait when it is not.
  take(name = '') {
    const wait = this.wait(name)
    if (wait === 0) this.add(name)
    return wait
  }

  #recent(name: string, now: number) {
    return (this.#events.get(name) ?? []).filter((at) => at > now - this.windowMs)
  }

  #forget(now: number) {
    for (const [name, events] of this.#events) {
      if (Number(events.at(-1)) > now - this.windowMs) return
      this.#events.delete(name)
    }
  }
}
