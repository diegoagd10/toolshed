import { mkdirSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import type { DynamicModule, Type } from '@nestjs/common'
import { NestFactory } from '@nestjs/core'
import type { NestExpressApplication } from '@nestjs/platform-express'
import { AdminContext } from './admin/context.js'
import { AdminModule } from './admin/modules.js'
import { AgentContext } from './agent/context.js'
import { AgentModule } from './agent/modules.js'
import type { Config } from './config.js'
import { McpModule } from './mcp/modules.js'
import { Runner } from './runner/runner.js'
import { openStore } from './store/repository.js'

export type Ports = { agent: number, admin: number }
export type Running = { ports: Ports, close: () => Promise<void> }

class AgentPort {}

export async function start(config: Config): Promise<Running> {
  const store = openStore(config.DATA)
  const workDir = join(config.DATA, 'work')
  mkdirSync(workDir, { recursive: true, mode: 0o700 })
  const context = new AgentContext(config, store, new Runner(), workDir)
  // Port 4400 serves the REST API and MCP. Neither module is reachable from 4401.
  const agent = await createApp({
    module: AgentPort,
    imports: [AgentModule.register(context), McpModule.register(context)],
  })
  const admin = await createApp(AdminModule.register(new AdminContext(config, store)))
  admin.useBodyParser('urlencoded', { limit: '16kb', extended: false })
  const close = async () => {
    await Promise.all([agent.close(), admin.close()])
    store.close()
  }
  try {
    return {
      ports: {
        agent: await listen(agent, config.AGENT_PORT),
        admin: await listen(admin, config.ADMIN_PORT),
      },
      close,
    }
  } catch (error) {
    await close()
    throw error
  }
}

async function createApp(module: Type | DynamicModule) {
  const app = await NestFactory.create<NestExpressApplication>(module, {
    abortOnError: false,
    logger: ['error', 'warn'],
    bodyParser: false,
    // On SIGTERM, a kept-alive socket, such as one left by an MCP listen stream, would hold the
    // process for up to 5 s.
    forceCloseConnections: true,
  })
  app.useBodyParser('json', { limit: '1mb' })
  app.disable('x-powered-by')
  return app
}

async function listen(app: NestExpressApplication, port: number) {
  const server = await app.listen(port)
  return (server.address() as AddressInfo).port
}
