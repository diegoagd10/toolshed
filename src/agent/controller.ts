import { Controller, Get } from '@nestjs/common'

@Controller()
export class AgentController {
  @Get('health')
  health() {
    return { ok: true }
  }
}
