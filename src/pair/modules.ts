import { type DynamicModule, Module } from '@nestjs/common'
import { PairContext } from './context.js'
import { PairController } from './controller.js'

@Module({})
export class PairModule {
  static register(context: PairContext): DynamicModule {
    return {
      module: PairModule,
      controllers: [PairController],
      providers: [{ provide: PairContext, useValue: context }],
    }
  }
}
