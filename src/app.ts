import type { AddressInfo } from 'node:net'
import type { DynamicModule, Type } from '@nestjs/common'
import { NestFactory } from '@nestjs/core'
import type { NestExpressApplication } from '@nestjs/platform-express'
import { AdminContext } from './admin/context.js'
import { AdminModule } from './admin/modules.js'
import { AgentContext } from './agent/context.js'
import { logError } from './agent/errors.js'
import { AgentModule } from './agent/modules.js'
import type { Config } from './config.js'
import { McpModule } from './mcp/modules.js'
import { PairContext } from './pair/context.js'
import { PairModule } from './pair/modules.js'
import { Pairs } from './pair/pairs.js'
import { Runner } from './runner/runner.js'
import { openStore } from './store/repository.js'

export type Ports = { agent: number, admin: number }
export type Running = { ports: Ports, close: () => Promise<void> }

class AgentPort {}

const cleanEveryMs = 10 * 60 * 1000

export async function start(config: Config): Promise<Running> {
  const store = openStore(config.DATA, config.MAX_DISK_MB * 2 ** 20)
  // Files expire after 24 hours. Cleaning at start also removes what a crash left behind.
  const clean = () => store.files.clean()
    .catch(logError)
  await clean()
  const cleaning = setInterval(clean, cleanEveryMs)
  const context = new AgentContext(config, store, new Runner(), store.files.workDir)
  // One set of pairing requests: agents start them on 4400 and the owner approves them on 4401.
  const pairs = new Pairs()
  // Port 4400 serves the REST API and MCP. Neither module is reachable from 4401.
  const agent = await createApp({
    module: AgentPort,
    imports: [
      AgentModule.register(context),
      McpModule.register(context),
      PairModule.register(new PairContext(context, pairs)),
    ],
  })
  const admin = await createApp(AdminModule.register(new AdminContext(config, store, pairs)))
  admin.useBodyParser('urlencoded', { limit: '16kb', extended: false })
  const close = async () => {
    clearInterval(cleaning)
    await Promise.all([agent.close(), admin.close()])
    // A clean in progress must end before the database closes. Joining it or running one more
    // is harmless.
    await clean()
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
