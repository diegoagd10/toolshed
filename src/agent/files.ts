import { randomBytes } from 'node:crypto'
import { open } from 'node:fs/promises'
import { pipeline, Readable } from 'node:stream'
import type { Request, Response } from 'express'
import { z } from 'zod'
import type { StoredFile } from '../files/repository.js'
import type { AgentContext } from './context.js'
import { ApiError, invalidInput } from './errors.js'

const maxUploadBytes = 50 * 2 ** 20
const linkLifetimeMs = 15 * 60 * 1000

const name = z.string()
  .min(1)
  .max(200)
  .regex(/^[^/\\\p{Cc}]+$/u, 'must not contain slashes or control characters')

const uploadRequest = z.strictObject({ name })
const signedQuery = z.object({ expires: z.coerce.number(), signature: z.string() })
const uploadQuery = signedQuery.extend({ name })

function signedUrl(context: AgentContext, method: string, id: string, extra: string[][] = []) {
  const { expiresAt, signature } = context.store.links.sign({ method, id }, linkLifetimeMs)
  const query = new URLSearchParams([...extra, ['expires', String(expiresAt)], ['signature', signature]])
  return { url: `${context.config.PUBLIC_URL}/f/${id}?${query}`, expiresAt }
}

function verified<Query extends typeof signedQuery>(
  context: AgentContext,
  method: string,
  id: string,
  query: unknown,
  schema: Query,
): z.output<Query> {
  const parsed = schema.safeParse(query)
  const link = { method, id, expiresAt: parsed.data?.expires ?? 0, signature: parsed.data?.signature ?? '' }
  if (parsed.success && context.store.links.verify(link)) return parsed.data
  throw new ApiError(403, 'bad_signature', 'the link is invalid or has expired; ask for a new one')
}

export function describe(context: AgentContext, file: StoredFile) {
  return {
    file_id: file.id,
    name: file.name,
    mime: file.mime,
    bytes: file.bytes,
    expires_at: new Date(file.expiresAt)
      .toISOString(),
    download_url: signedUrl(context, 'GET', file.id).url,
  }
}

export function startUpload(context: AgentContext, body: unknown) {
  const parsed = uploadRequest.safeParse(body)
  if (!parsed.success) throw invalidInput(parsed.error)
  const id = `up_${randomBytes(16)
    .toString('base64url')}`
  const { url, expiresAt } = signedUrl(context, 'PUT', id, [['name', parsed.data.name]])
  return {
    upload_url: url,
    method: 'PUT',
    expires_at: new Date(expiresAt)
      .toISOString(),
    command: `curl --silent --show-error --fail-with-body -T <path> '${url}'`,
  }
}

function tooLarge() {
  return new ApiError(413, 'too_large', `the limit is ${maxUploadBytes / 2 ** 20} MB`, [['Connection', 'close']])
}

async function* limited(request: Request) {
  let bytes = 0
  for await (const chunk of request) {
    bytes += (chunk as Buffer).byteLength
    if (bytes > maxUploadBytes) throw tooLarge()
    yield chunk as Buffer
  }
}

// The body streams to disk. A file appears only when the whole body arrived within the limit.
export async function receiveUpload(
  context: AgentContext,
  id: string,
  query: unknown,
  request: Request,
) {
  const { name } = verified(context, 'PUT', id, query, uploadQuery)
  if (Number(request.headers['content-length'] ?? 0) > maxUploadBytes) throw tooLarge()
  const file = await context.store.files.save(name, 'application/octet-stream', Readable.from(limited(request)))
  return describe(context, file)
}

export async function sendFile(
  context: AgentContext,
  id: string,
  query: unknown,
  response: Response,
) {
  verified(context, 'GET', id, query, signedQuery)
  const { file, path } = context.store.files.find(id)
  const handle = await open(path)
  response.attachment(file.name)
  response.set({
    'Content-Type': file.mime,
    'Content-Length': String(file.bytes),
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'private, no-store',
  })
  pipeline(handle.createReadStream(), response, () => undefined)
}
