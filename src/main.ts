import { once } from 'node:events'
import { start } from './app.js'
import { ConfigError, parseConfig } from './config.js'

const stopped = Promise.race([once(process, 'SIGTERM'), once(process, 'SIGINT')])

try {
  const { OWNER_PASSWORD, PUBLIC_URL, ADMIN_URL, DATA } = process.env
  const config = parseConfig({ OWNER_PASSWORD, PUBLIC_URL, ADMIN_URL, DATA })
  const running = await start(config, { agent: 4400, admin: 4401 })
  void stopped.then(running.close)
} catch (error) {
  const message = error instanceof Error ? error.message : String(error)
  console.error(error instanceof ConfigError ? message : `Could not start: ${message}`)
  process.exitCode = 1
}
