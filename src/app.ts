import type { AddressInfo } from 'node:net';
import { Controller, Get, Module, type Type } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Config } from './config.js';

@Controller()
class AgentController {
  @Get('health')
  health() {
    return { ok: true };
  }
}

@Module({ controllers: [AgentController] })
class AgentModule {}

@Controller()
class AdminController {
  @Get('health')
  health() {
    return { ok: true };
  }
}

@Module({ controllers: [AdminController] })
class AdminModule {}

export type Ports = { agent: number; admin: number };
export type Running = { ports: Ports; close: () => Promise<void> };

export async function start(_config: Config, ports: Ports): Promise<Running> {
  const agent = await createApp(AgentModule);
  const admin = await createApp(AdminModule);
  const close = async () => {
    await Promise.all([agent.close(), admin.close()]);
  };
  try {
    return {
      ports: { agent: await listen(agent, ports.agent), admin: await listen(admin, ports.admin) },
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}

async function createApp(module: Type) {
  const app = await NestFactory.create<NestExpressApplication>(module, {
    abortOnError: false,
    logger: ['error', 'warn'],
  });
  app.disable('x-powered-by');
  return app;
}

async function listen(app: NestExpressApplication, port: number) {
  const server = await app.listen(port);
  return (server.address() as AddressInfo).port;
}
