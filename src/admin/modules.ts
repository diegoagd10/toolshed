import { type DynamicModule, Module } from '@nestjs/common'
import { AdminContext } from './context.js'
import { AdminController } from './controller.js'

@Module({})
export class AdminModule {
  static register(context: AdminContext): DynamicModule {
    return {
      module: AdminModule,
      controllers: [AdminController],
      providers: [{ provide: AdminContext, useValue: context }],
    }
  }
}
