import { type DynamicModule, Module } from '@nestjs/common'
import { APP_FILTER } from '@nestjs/core'
import { AgentContext } from './context.js'
import { AgentController } from './controller.js'
import { ApiErrorFilter } from './errors.js'

@Module({})
export class AgentModule {
  static register(context: AgentContext): DynamicModule {
    return {
      module: AgentModule,
      controllers: [AgentController],
      providers: [
        { provide: AgentContext, useValue: context },
        { provide: APP_FILTER, useClass: ApiErrorFilter },
      ],
    }
  }
}
