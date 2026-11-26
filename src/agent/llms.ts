import { z } from 'zod'
import { TOOLS } from '../tools/registry.js'

export function catalog() {
  return TOOLS.map(({ id, title, summary, tags, input, example }) => ({
    id,
    title,
    summary,
    tags,
    input: z.toJSONSchema(input),
    example,
  }))
}

export function llmsText(base: string) {
  const tools = TOOLS.map(({ id, summary, example }) => `- ${id}: ${summary} Example: ${JSON.stringify(example)}`)
  return `# toolshed

> Private tools for your agents. Files go in and come out by link, never as base64.

## Use

- Send \`Authorization: Bearer $TOOLSHED_API_KEY\` on every /v1 request. The owner gives you the key. Never print it or commit it.
- Check the key: GET ${base}/v1/me
- List the tools with their JSON Schema: GET ${base}/v1/tools
- Run a tool: POST ${base}/v1/call/<id> with the input as a JSON body. Files come back with a download_url that works for 15 minutes. Save each one with \`curl -o <name> "<download_url>"\`.
- Send a local file: POST ${base}/v1/uploads with {"name":"<file name>"}. Run the command it returns, with the path of the file, and pass the file_id it prints to a tool. Up to 50 MB. Files last 24 hours.
- Run one curl per shell command.
- Errors come as {"error":{"code":"...","message":"..."}}. On 503 busy, wait the seconds in Retry-After and send the same request again.

## Tools

${tools.join('\n')}
`
}
