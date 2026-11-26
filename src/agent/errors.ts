import { STATUS_CODES } from 'node:http'
import { type ArgumentsHost, Catch, type ExceptionFilter, HttpException } from '@nestjs/common'
import type { Response } from 'express'
import type { z } from 'zod'
import { StoreError } from '../store/error.js'

export class ApiError extends Error {
  override name = 'ApiError'
  readonly status: number
  readonly code: string
  readonly headers: [string, string][]

  constructor(status: number, code: string, message: string, headers: [string, string][] = []) {
    super(message)
    this.status = status
    this.code = code
    this.headers = headers
  }
}

// Every error leaves as {"error":{"code","message"}}. An unexpected one shows no detail.
@Catch()
export class ApiErrorFilter implements ExceptionFilter {
  catch(error: unknown, host: ArgumentsHost) {
    const response = host.switchToHttp()
      .getResponse<Response>()
    const known = error instanceof ApiError ? error : fromNest(error)
    for (const [name, value] of known.headers) response.setHeader(name, value)
    response.status(known.status)
      .json({ error: { code: known.code, message: known.message } })
  }
}

export function invalidInput(error: z.ZodError) {
  const problems = error.issues.map((issue) => `${issue.path.join('.')} ${issue.message}`)
  return new ApiError(422, 'invalid_input', problems.join('; '))
}

function fromNest(error: unknown) {
  if (error instanceof StoreError) return new ApiError(404, error.code, error.message)
  if (error instanceof HttpException) {
    const status = error.getStatus()
    const code = String(STATUS_CODES[status])
      .toLowerCase()
      .replaceAll(' ', '_')
    return new ApiError(status, code, error.message)
  }
  // A client that drops the connection is not a server error, and nobody reads the answer.
  if ((error as { code?: unknown }).code === 'ECONNRESET') {
    return new ApiError(400, 'aborted', 'the request was cut before it finished')
  }
  console.error(error)
  return new ApiError(500, 'internal', 'internal error')
}
