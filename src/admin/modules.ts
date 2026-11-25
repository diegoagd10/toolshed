import { Module } from '@nestjs/common'
import { AdminController } from './controller.js'

@Module({ controllers: [AdminController] })
export class AdminModule {}
