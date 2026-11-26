import { type CallToolResult, McpServer } from '@modelcontextprotocol/server'
import { callTool } from '../agent/call.js'
import type { AgentContext } from '../agent/context.js'
import { ApiError } from '../agent/errors.js'
import { startUpload, uploadRequest } from '../agent/files.js'
import { TOOLS } from '../tools/registry.js'

const instructions = `toolshed is the private tool server of the person you work for, run by them. Files sent to it stay with them and are deleted after 24 hours. Use its tools for the jobs they cover.
Files go in and come out by link, never as base64.
To send a local file, call file_upload with its name, run the curl command it returns with the path in place of <path>, and pass the file_id it prints to a tool.
Results list each file with its pages, when it is a PDF, and a download_url that works for 15 minutes. Save it with curl -o <name> "<download_url>".`

type Described = { name: string, mime: string, download_url: string }

// Some clients accept only letters, digits, _ and - in a tool name, so pdf.merge is pdf_merge.
export function mcpName(id: string) {
  return id.replace('.', '_')
}

function success(result: object, files: Described[] = []): CallToolResult {
  const links = files.map(({ name, mime, download_url: uri }) => ({
    type: 'resource_link' as const,
    uri,
    name,
    mimeType: mime,
  }))
  return { content: [{ type: 'text', text: JSON.stringify(result) }, ...links] }
}

// A tool error is an answer the agent can act on, with the same code as the REST API.
function failure(error: unknown): CallToolResult {
  const known = error instanceof ApiError ? error : new ApiError(500, 'internal', 'internal error')
  if (known !== error) console.error(error)
  const { code, message } = known
  return { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: { code, message } }) }] }
}

export function mcpServer(context: AgentContext, keyId: string) {
  const server = new McpServer({ name: 'toolshed', version: '1.0.0' }, { instructions })
  for (const tool of TOOLS) {
    const config = { title: tool.title, description: tool.summary, inputSchema: tool.input }
    server.registerTool(mcpName(tool.id), config, async (input: unknown) => {
      try {
        const result = await callTool(context, keyId, tool.id, input, 'mcp')
        return success(result, result.files)
      } catch (error) {
        return failure(error)
      }
    })
  }
  server.registerTool('file_upload', {
    title: 'Upload a file',
    description: 'Get a curl command that sends a local file of up to 50 MB. It prints the file_id to pass to a tool.',
    inputSchema: uploadRequest,
  }, (input) => success(startUpload(context, input)))
  return server
}
