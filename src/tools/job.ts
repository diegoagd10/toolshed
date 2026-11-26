import { z } from 'zod'
import type { ToolErrorCode } from './tool.js'

export const jobSchema = z.strictObject({
  tool: z.string(),
  input: z.unknown(),
  files: z.array(z.strictObject({ id: z.string(), path: z.string() })),
  outputDir: z.string(),
})

export type Job = z.output<typeof jobSchema>
export type JobFile = { name: string, mime: string, bytes: number, path: string, pages?: number }
export type JobResult =
  | { files: JobFile[] }
  | { error: { code: ToolErrorCode, message: string } }
