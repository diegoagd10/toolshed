import { once } from 'node:events'
import { start } from './app.js'
import { ConfigError, parseConfig } from './config.js'

const stopped = Promise.race([once(process, 'SIGTERM'), once(process, 'SIGINT')])

try {
  const { OWNER_PASSWORD, PUBLIC_URL, ADMIN_URL, DATA, AGENT_PORT, ADMIN_PORT } = process.env
  const environment = { OWNER_PASSWORD, PUBLIC_URL, ADMIN_URL, DATA, AGENT_PORT, ADMIN_PORT }
  const config = parseConfig(environment)
  const running = await start(config)
  console.log(`toolshed: agents on port ${running.ports.agent}, admin on port ${running.ports.admin}`)
  void stopped.then(running.close)
} catch (error) {
  console.error(error instanceof ConfigError ? error.message : `Could not start: ${String(error)}`)
  process.exitCode = 1
}
