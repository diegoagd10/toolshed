import { Module } from '@nestjs/common'
import { AgentController } from './controller.js'

@Module({ controllers: [AgentController] })
export class AgentModule {}
