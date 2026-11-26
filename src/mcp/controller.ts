import { pipeline, Readable } from 'node:stream'
import type { ReadableStream } from 'node:stream/web'
import { All, Controller, Inject, type OnModuleDestroy, Req, Res } from '@nestjs/common'
import { createMcpHandler, type McpHttpHandler, type McpRequestContext } from '@modelcontextprotocol/server'
import type { Request, Response } from 'express'
import { authenticate } from '../agent/auth.js'
import { AgentContext } from '../agent/context.js'
import { mcpServer } from './server.js'

// The SDK speaks web Request and Response. Express has already parsed the JSON body.
function webRequest(request: Request) {
  const headers = new Headers()
  const raw = request.rawHeaders
  for (let index = 0; index < raw.length; index += 2) {
    headers.append(String(raw[index]), String(raw[index + 1]))
  }
  return new globalThis.Request(new URL(request.originalUrl, 'http://localhost'), {
    method: request.method,
    headers,
  })
}

@Controller()
export class McpController implements OnModuleDestroy {
  readonly #context: AgentContext
  readonly #handler: McpHttpHandler

  constructor(@Inject(AgentContext) context: AgentContext) {
    this.#context = context
    // Each request gets a fresh server for the key that sent it, so nothing is kept between calls.
    const factory = ({ authInfo }: McpRequestContext) => {
      return mcpServer(context, String(authInfo?.clientId))
    }
    this.#handler = createMcpHandler(factory)
  }

  @All('mcp')
  async mcp(@Req() request: Request, @Res() response: Response) {
    const key = authenticate(this.#context, request.headers.authorization)
    const answer = await this.#handler.fetch(webRequest(request), {
      authInfo: { token: key.prefix, clientId: key.id, scopes: [] },
      parsedBody: request.body,
    })
    response.status(answer.status)
    answer.headers.forEach((value, name) => response.setHeader(name, value))
    if (!answer.body) return response.end()
    pipeline(Readable.fromWeb(answer.body as ReadableStream), response, () => undefined)
  }

  onModuleDestroy() {
    return this.#handler.close()
  }
}
