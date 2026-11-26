import { Body, Controller, Get, Header, Headers, HttpCode, Inject, Param, Post, Put, Query, Req, Res } from '@nestjs/common'
import type { Request, Response } from 'express'
import { authenticate } from './auth.js'
import { callTool } from './call.js'
import { AgentContext } from './context.js'
import { receiveUpload, sendFile, startUpload } from './files.js'
import { catalog, llmsText } from './llms.js'

@Controller()
export class AgentController {
  readonly #context: AgentContext

  constructor(@Inject(AgentContext) context: AgentContext) {
    this.#context = context
  }

  @Get('health')
  health() {
    return { ok: true }
  }

  @Get('llms.txt')
  @Header('Content-Type', 'text/plain; charset=utf-8')
  llms() {
    return llmsText(this.#context.config.PUBLIC_URL)
  }

  @Get('v1/tools')
  tools() {
    return catalog()
  }

  @Get('v1/me')
  me(@Headers('authorization') header?: string) {
    const { id, name, prefix, createdAt } = authenticate(this.#context, header)
    return { id, name, prefix, created_at: createdAt }
  }

  @Post('v1/call/:id')
  @HttpCode(200)
  call(@Param('id') id: string, @Body() body: unknown, @Headers('authorization') header?: string) {
    return callTool(this.#context, authenticate(this.#context, header), id, body)
  }

  @Post('v1/uploads')
  @HttpCode(200)
  uploads(@Body() body: unknown, @Headers('authorization') header?: string) {
    authenticate(this.#context, header)
    return startUpload(this.#context, body)
  }

  @Put('f/:id')
  receive(@Param('id') id: string, @Query() query: unknown, @Req() request: Request) {
    return receiveUpload(this.#context, id, query, request)
  }

  @Get('f/:id')
  download(@Param('id') id: string, @Query() query: unknown, @Res() response: Response) {
    return sendFile(this.#context, id, query, response)
  }
}
