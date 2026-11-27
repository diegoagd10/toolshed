import type { AgentContext } from '../agent/context.js'
import { SlidingWindow } from '../limits/window.js'
import type { Pairs } from './pairs.js'

export class PairContext {
  readonly agent: AgentContext
  readonly pairs: Pairs
  // Pairings started per IP.
  readonly starts = new SlidingWindow(60_000, 5)

  constructor(agent: AgentContext, pairs: Pairs) {
    this.agent = agent
    this.pairs = pairs
  }
}
