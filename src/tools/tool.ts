import { z } from 'zod'

export type ToolErrorCode =
  | 'bad_range'
  | 'file_not_found'
  | 'invalid_input'
  | 'not_a_pdf'
  | 'tool_not_found'

export class ToolError extends Error {
  override name = 'ToolError'
  readonly code: ToolErrorCode

  constructor(code: ToolErrorCode, message: string) {
    super(message)
    this.code = code
  }
}

// `pages` is set for a PDF, so an agent can choose ranges without opening the file.
export type OutputFile = { name: string, mime: string, data: Uint8Array, pages?: number }
export type ToolContext = { read: (fileId: string) => Promise<Uint8Array> }

export const fileId = z.string()
  .regex(/^file_[A-Za-z0-9_-]+$/)
  .describe('An uploaded file or an earlier result')

export type ToolDefinition<Id extends string, Input extends z.ZodObject> = {
  id: Id
  title: string
  summary: string
  tags: string[]
  input: Input
  example: z.input<Input>
  run: (input: z.output<Input>, context: ToolContext) => Promise<OutputFile[]>
}

export function defineTool<const Id extends string, Input extends z.ZodObject>(
  definition: ToolDefinition<Id, Input>,
) {
  definition.input.parse(definition.example)
  return {
    ...definition,
    async run(raw: unknown, context: ToolContext) {
      const parsed = definition.input.safeParse(raw)
      if (!parsed.success) {
        const problems = parsed.error.issues.map((issue) => `${issue.path.join('.')} ${issue.message}`)
        throw new ToolError('invalid_input', problems.join('; '))
      }
      return definition.run(parsed.data, context)
    },
  }
}
