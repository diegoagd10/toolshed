import type { Config } from '../config.js'
import type { Runner } from '../runner/runner.js'
import type { Store } from '../store/repository.js'

export class AgentContext {
  readonly config: Config
  readonly store: Store
  readonly runner: Runner
  readonly workDir: string

  constructor(config: Config, store: Store, runner: Runner, workDir: string) {
    this.config = config
    this.store = store
    this.runner = runner
    this.workDir = workDir
  }
}
