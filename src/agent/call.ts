import { randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { RunnerErrorCode } from '../runner/runner.js'
import { TOOLS } from '../tools/registry.js'
import type { ToolErrorCode } from '../tools/tool.js'
import type { AgentContext } from './context.js'
import { ApiError, invalidInput, toApiError } from './errors.js'
import { describe } from './files.js'

function statusOf(code: ToolErrorCode | RunnerErrorCode) {
  switch (code) {
    case 'busy': return 503
    case 'crashed': return 500
    case 'file_not_found': return 404
    default: return 422
  }
}

// Every string in the input that is a stored file id. Unknown ids are left for the tool to report.
function storedFiles(context: AgentContext, input: unknown) {
  const matches = JSON.stringify(input)
    .matchAll(/"(file_[\w-]+)"/g)
  const ids = new Set(Array.from(matches, (match) => String(match[1])))
  return [...ids].flatMap((id) => {
    try {
      return [{ id, path: context.store.files.find(id).path }]
    } catch {
      return []
    }
  })
}

async function run(context: AgentContext, id: string, body: unknown) {
  const tool = TOOLS.find((candidate) => candidate.id === id)
  if (!tool) throw new ApiError(404, 'tool_not_found', `there is no tool named ${id}; see GET /v1/tools`)
  const parsed = tool.input.safeParse(body)
  if (!parsed.success) throw invalidInput(parsed.error)
  const outputDir = join(context.workDir, randomUUID())
  const files = storedFiles(context, parsed.data)
  const result = await context.runner.run({ tool: id, input: parsed.data, files, outputDir })
  if ('error' in result) {
    const { code, message } = result.error
    const headers: [string, string][] = code === 'busy' ? [['Retry-After', '5']] : []
    throw new ApiError(statusOf(code), code, message, headers)
  }
  try {
    const files = []
    for (const { name, mime, path, bytes, pages } of result.files) {
      const saved = await context.store.files.save(name, mime, createReadStream(path), bytes)
      files.push(describe(context, saved, pages))
    }
    return { files }
  } finally {
    await rm(outputDir, { recursive: true, force: true })
  }
}

export async function callTool(
  context: AgentContext,
  keyId: string,
  id: string,
  body: unknown,
  via: 'rest' | 'mcp',
) {
  // A refused call is not recorded, so a runaway agent cannot grow the activity log either.
  const wait = context.calls.take(keyId)
  if (wait > 0) {
    const message = `a key can make ${context.calls.max} tool calls a minute; try again in ${wait} s`
    throw new ApiError(429, 'rate_limited', message, [['Retry-After', String(wait)]])
  }
  const started = performance.now()
  let error: string | null = null
  try {
    return await run(context, id, body)
  } catch (caught) {
    const known = toApiError(caught)
    error = known.code
    throw known
  } finally {
    context.store.calls.record({
      at: new Date()
        .toISOString(),
      keyId,
      tool: id,
      via,
      ms: Math.round(performance.now() - started),
      error,
    })
  }
}
