import { z } from 'zod'
import { TOOLS } from '../tools/registry.js'

export function catalog() {
  return TOOLS.map(({ id, title, summary, tags, input, example }) => ({
    id,
    title,
    summary,
    tags,
    // The input side: a field with a default is optional for the caller.
    input: z.toJSONSchema(input, { io: 'input' }),
    example,
  }))
}

export function llmsText(base: string) {
  const tools = TOOLS.map(({ id, summary, example }) => `- ${id}: ${summary} Example: ${JSON.stringify(example)}`)
  return `# toolshed

> The private tool server of the person you work for, run by them. Files sent to it stay with them and are deleted after 24 hours. Files go in and come out by link, never as base64.

## Connect

Do this once, when you have no key.

1. POST ${base}/pair with {"agent":"<your name, such as Claude Code>"}. It returns pair_id and code.
2. Tell the owner, with the code exactly as it came: "Type the code <code> on the Start page of your toolshed dashboard." Do not wait for an answer.
3. Run this single curl command, not a loop: \`curl -s -o <file> -w '%{http_code}' -X POST ${base}/pair/token -H 'Content-Type: application/json' -d '{"pair_id":"<pair_id>"}'\`, with <file> outside the project, such as in your scratchpad. The server holds it up to 25 seconds and answers as soon as the owner types the code. On 202, run the same command again. On 200, <file> holds your key in the field "key". The code works for 10 minutes and once.
4. That file is where the key lives. Use it as \`Authorization: Bearer $(jq -r .key <file>)\`, never print it and never put it in the project. If you have a secret store, keep the key there as TOOLSHED_API_KEY instead.

## Use

- Send \`Authorization: Bearer $TOOLSHED_API_KEY\` on every /v1 request except /v1/tools.
- Check the key: GET ${base}/v1/me
- List the tools with their JSON Schema: GET ${base}/v1/tools
- Run a tool: POST ${base}/v1/call/<id> with the input as a JSON body. Files come back with a name and a download_url that works for 15 minutes. Save each one with \`curl -o <name> "<download_url>"\`, choosing the name you need.
- Send a local file: POST ${base}/v1/uploads with the JSON body {"name":"<file name>"}. It returns a curl command that PUTs the file to a signed link, which needs no key and works for 15 minutes. Put the path of the file in place of <path>, run it, and pass the file_id it prints to a tool. Up to 50 MB. Files last 24 hours.
- Run one curl per shell command.
- MCP clients connect to ${base}/mcp over Streamable HTTP, with the same Authorization header. Upload with the file_upload tool.
- PDF results carry pages, the page count of each file.
- Errors come as {"error":{"code":"...","message":"..."}}. On 503 busy, wait the seconds in Retry-After and send the same request again.

## Tools

${tools.join('\n')}
`
}
