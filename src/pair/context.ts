import type { AgentContext } from '../agent/context.js'
import type { Pairs } from './pairs.js'

export class PairContext {
  readonly agent: AgentContext
  readonly pairs: Pairs

  constructor(agent: AgentContext, pairs: Pairs) {
    this.agent = agent
    this.pairs = pairs
  }
}
