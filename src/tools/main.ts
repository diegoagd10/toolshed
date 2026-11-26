import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { json } from 'node:stream/consumers'
import { runTool } from './registry.js'
import { type Job, jobSchema, type JobResult } from './job.js'
import { ToolError } from './tool.js'

async function runJob(job: Job): Promise<JobResult> {
  async function read(id: string) {
    const file = job.files.find((candidate) => candidate.id === id)
    if (!file) throw new ToolError('file_not_found', `${id} does not exist`)
    return readFile(file.path)
  }

  try {
    const outputs = await runTool(job.tool, job.input, { read })
    const files = await Promise.all(outputs.map(async ({ data, ...file }, index) => {
      const path = join(job.outputDir, String(index))
      await writeFile(path, data)
      return { ...file, bytes: data.byteLength, path }
    }))
    return { files }
  } catch (error) {
    if (!(error instanceof ToolError)) throw error
    return { error: { code: error.code, message: error.message } }
  }
}

const result = await runJob(jobSchema.parse(await json(process.stdin)))
process.stdout.write(JSON.stringify(result))
