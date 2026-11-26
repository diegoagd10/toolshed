import { type DynamicModule, Module } from '@nestjs/common'
import { AgentContext } from '../agent/context.js'
import { McpController } from './controller.js'

@Module({})
export class McpModule {
  static register(context: AgentContext): DynamicModule {
    return {
      module: McpModule,
      controllers: [McpController],
      providers: [{ provide: AgentContext, useValue: context }],
    }
  }
}
