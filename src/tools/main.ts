import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { json } from 'node:stream/consumers'
import { z } from 'zod'
import { runTool } from './registry.js'
import { ToolError, type ToolErrorCode } from './tool.js'

const jobSchema = z.strictObject({
  tool: z.string(),
  input: z.unknown(),
  files: z.array(z.strictObject({ id: z.string(), path: z.string() })),
  outputDir: z.string(),
})

export type Job = z.output<typeof jobSchema>
export type JobFile = { name: string, mime: string, bytes: number, path: string }
export type JobResult =
  | { files: JobFile[] }
  | { error: { code: ToolErrorCode, message: string } }

async function runJob(job: Job): Promise<JobResult> {
  async function read(id: string) {
    const file = job.files.find((candidate) => candidate.id === id)
    if (!file) throw new ToolError('file_not_found', `${id} does not exist`)
    return readFile(file.path)
  }

  try {
    const outputs = await runTool(job.tool, job.input, { read })
    const files = await Promise.all(outputs.map(async ({ name, mime, data }, index) => {
      const path = join(job.outputDir, String(index))
      await writeFile(path, data)
      return { name, mime, bytes: data.byteLength, path }
    }))
    return { files }
  } catch (error) {
    if (!(error instanceof ToolError)) throw error
    return { error: { code: error.code, message: error.message } }
  }
}

const result = await runJob(jobSchema.parse(await json(process.stdin)))
process.stdout.write(JSON.stringify(result))
