import type { Config } from '../config.js'
import { SlidingWindow } from '../limits/window.js'
import type { Runner } from '../runner/runner.js'
import type { Store } from '../store/repository.js'

export class AgentContext {
  readonly config: Config
  readonly store: Store
  readonly runner: Runner
  readonly workDir: string
  // Tool calls per key, over REST and MCP together.
  readonly calls = new SlidingWindow(60_000, 60)

  constructor(config: Config, store: Store, runner: Runner, workDir: string) {
    this.config = config
    this.store = store
    this.runner = runner
    this.workDir = workDir
  }
}
