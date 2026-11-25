import { pdfMerge, pdfSplit } from './pdf.js'
import { qrCreate } from './qr.js'
import { type ToolContext, ToolError } from './tool.js'

export const TOOLS = [qrCreate, pdfMerge, pdfSplit] as const

export type ToolId = (typeof TOOLS)[number]['id']

export async function runTool(id: string, input: unknown, context: ToolContext) {
  const tool = TOOLS.find((candidate) => candidate.id === id)
  if (!tool) throw new ToolError('tool_not_found', `there is no tool named ${id}`)
  return tool.run(input, context)
}
