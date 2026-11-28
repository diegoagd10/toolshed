import { Body, Controller, HttpCode, Inject, Post, Req, Res } from '@nestjs/common'
import type { Request, Response } from 'express'
import { z } from 'zod'
import { ApiError, invalidInput } from '../agent/errors.js'
import { PairContext } from './context.js'

const maxWaitSeconds = 25

const startRequest = z.strictObject({
  agent: z.string()
    .trim()
    .min(1)
    .max(60)
    .describe('Your name, such as Claude Code'),
})
const tokenRequest = z.strictObject({
  pair_id: z.string(),
  wait: z.number()
    .int()
    .min(0)
    .max(maxWaitSeconds)
    .default(maxWaitSeconds),
})

// This port is reached through Tailscale Serve, which appends the client's address to
// X-Forwarded-For. Entries before the last one come from the client, so only the last is trusted.
function clientAddress(request: Request) {
  const forwarded = request.get('x-forwarded-for')
    ?.split(',')
    .at(-1)
    ?.trim()
  return forwarded || String(request.socket.remoteAddress)
}

@Controller('pair')
export class PairController {
  readonly #context: PairContext

  constructor(@Inject(PairContext) context: PairContext) {
    this.#context = context
  }

  @Post()
  @HttpCode(200)
  start(@Body() body: unknown, @Req() request: Request) {
    const ip = clientAddress(request)
    const { starts } = this.#context
    const wait = starts.take(ip)
    if (wait > 0) {
      const message = `an address can start ${starts.max} pairings a minute; try again in ${wait} s`
      throw new ApiError(429, 'rate_limited', message, [['Retry-After', String(wait)]])
    }
    const parsed = startRequest.safeParse(body)
    if (!parsed.success) throw invalidInput(parsed.error)
    const { pairs } = this.#context
    const started = pairs.start(parsed.data.agent)
    if (!started) {
      const message = `${pairs.maxPending} agents are waiting for the owner; try again later`
      throw new ApiError(429, 'too_many_pairs', message, [['Retry-After', '60']])
    }
    return {
      pair_id: started.id,
      code: started.code,
      expires_at: new Date(started.expiresAt)
        .toISOString(),
      message: `Tell the owner: "Type the code ${started.code} on the Start page of your toolshed dashboard." Then POST /pair/token with {"pair_id":"${started.id}"}.`,
    }
  }

  @Post('token')
  async token(@Body() body: unknown, @Res({ passthrough: true }) response: Response) {
    const parsed = tokenRequest.safeParse(body)
    if (!parsed.success) throw invalidInput(parsed.error)
    const { pair_id: id, wait } = parsed.data
    const claimed = await this.#context.pairs.claim(id, wait * 1000)
    if (claimed === 'unknown') {
      throw new ApiError(404, 'pair_not_found', 'this pair_id is unknown, expired or already used; POST /pair to start again')
    }
    if (claimed === 'pending') {
      response.status(202)
      return { status: 'pending', message: 'The owner has not typed the code yet. Run the same command again now.' }
    }
    const { key, secret } = this.#context.agent.store.keys.create(claimed.agent)
    response.status(200)
    return {
      key: secret,
      name: key.name,
      message: 'Send the key as Authorization: Bearer on every /v1 request. Never print it or put it in the project.',
    }
  }
}
