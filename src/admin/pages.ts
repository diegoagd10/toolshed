import type { Call } from '../calls/repository.js'
import type { Key } from '../keys/repository.js'
import { TOOLS } from '../tools/registry.js'
import { type Html, html } from './html.js'

const sections = [['/', 'Start'], ['/tools', 'Tools'], ['/keys', 'Keys'], ['/activity', 'Activity']]

function when(iso: string) {
  return html`<time datetime="${iso}">${iso.slice(0, 16)
    .replace('T', ' ')} UTC</time>`
}

function document(title: string, body: Html) {
  return html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} · toolshed</title>
<link rel="stylesheet" href="/app.css">
<script src="/app.js" defer></script>
</head>
<body>
${body}
</body>
</html>`
}

function layout(current: string, title: string, content: Html) {
  const links = sections.map(([path = '', name = '']) => {
    return html`<a href="${path}"${path === current && html` aria-current="page"`}>${name}</a>`
  })
  return document(title, html`<header>
<span class="brand">toolshed</span>
<nav aria-label="Sections">${links}<form method="post" action="/logout"><button class="link">Sign out</button></form></nav>
</header>
<main>
${content}
</main>`)
}

export function loginPage(error: string | false) {
  return document('Sign in', html`<main class="login">
<h1>toolshed</h1>
<p class="lead">Sign in with the owner password.</p>
<form method="post" action="/login" class="card">
${error !== false && html`<p class="error" role="alert">${error}</p>`}
<label for="password">Password</label>
<input id="password" name="password" type="password" autocomplete="current-password" required autofocus>
<button>Sign in</button>
</form>
</main>`)
}

export function startPage(publicUrl: string, active: number, last: Call | undefined) {
  const status = last
    ? html`<p><span class="ok">●</span> Last call: <code>${last.tool}</code> ${when(last.at)}</p>`
    : html`<p class="muted">○ No calls yet.</p>`
  return layout('/', 'Start', html`<h1>Connect your agent</h1>
<p class="lead">Give it a key and the address of its instructions.</p>
<div class="card">
<h2>1. Create a key</h2>
<p>${active === 1 ? '1 key is active.' : `${active} keys are active.`} <a href="/keys">Create one for each agent.</a></p>
</div>
<div class="card">
<h2>2. Send this to an agent with a shell</h2>
<div class="copy"><pre id="instructions">Read ${publicUrl}/llms.txt and follow it. Your key is in TOOLSHED_API_KEY.</pre><button class="quiet" type="button" data-copy="instructions">Copy</button></div>
</div>
<div class="card">
<h2>Or add it as an MCP server</h2>
<div class="copy"><pre id="mcp">${publicUrl}/mcp</pre><button class="quiet" type="button" data-copy="mcp">Copy</button></div>
<p class="muted">Streamable HTTP, with the header <code>Authorization: Bearer &lt;key&gt;</code>.</p>
</div>
<div class="card" aria-label="Status">${status}</div>`)
}

export function toolsPage() {
  const cards = TOOLS.map((tool) => html`<div class="card">
<h2>${tool.title}</h2>
<p>${tool.summary}</p>
<pre>${tool.id} ${JSON.stringify(tool.example)}</pre>
</div>`)
  return layout('/tools', 'Tools', html`<h1>Tools</h1>
<p class="lead">The same tools your agents see.</p>
${cards}`)
}

export type Created = { name: string, secret: string }

export function keysPage(keys: Key[], created: Created | false, error: string | false) {
  const rows = keys.toReversed()
    .map((key) => html`<tr>
<td data-label="Name">${key.name}</td>
<td data-label="Key"><code>${key.prefix}…</code></td>
<td data-label="Created">${when(key.createdAt)}</td>
<td data-label="Last used">${key.lastUsedAt ? when(key.lastUsedAt) : 'never'}</td>
<td data-label="Status">${key.revokedAt ? html`<span class="muted">revoked</span>` : html`<form method="post" action="/keys/${key.id}/revoke"><button class="danger" aria-label="Revoke ${key.name}">Revoke</button></form>`}</td>
</tr>`)
  const shown = created !== false && html`<div class="card new" role="status">
<h2>Key for ${created.name}</h2>
<p>Copy it now. It is shown once and stored only as a hash.</p>
<div class="copy"><pre id="new-key">${created.secret}</pre><button type="button" data-copy="new-key">Copy</button></div>
</div>`
  const table = keys.length === 0
    ? html`<p class="muted">No keys yet.</p>`
    : html`<table>
<thead><tr><th>Name</th><th>Key</th><th>Created</th><th>Last used</th><th>Status</th></tr></thead>
<tbody>${rows}</tbody>
</table>`
  return layout('/keys', 'Keys', html`<h1>Keys</h1>
<p class="lead">One key per agent. Revoke a key and that agent stops at once.</p>
${shown}
<form method="post" action="/keys" class="card">
${error !== false && html`<p class="error" role="alert">${error}</p>`}
<div class="field"><div><label for="name">Agent name</label><input id="name" name="name" maxlength="60" required placeholder="Claude Code on my laptop"></div><button>Create key</button></div>
</form>
<div class="card">${table}</div>`)
}

export function activityPage(calls: Call[], keys: Key[]) {
  const names = new Map(keys.map((key) => [key.id, key.name]))
  const rows = calls.map((call) => html`<tr>
<td data-label="Time">${when(call.at)}</td>
<td data-label="Tool"><code>${call.tool}</code></td>
<td data-label="Key">${String(names.get(call.keyId))}</td>
<td data-label="Via">${call.via}</td>
<td data-label="Time taken">${call.ms} ms</td>
<td data-label="Result">${call.error === null ? html`<span class="ok">ok</span>` : html`<span class="error">${call.error}</span>`}</td>
</tr>`)
  const table = calls.length === 0
    ? html`<p class="muted">No calls yet.</p>`
    : html`<table>
<thead><tr><th>Time</th><th>Tool</th><th>Key</th><th>Via</th><th>Time taken</th><th>Result</th></tr></thead>
<tbody>${rows}</tbody>
</table>`
  return layout('/activity', 'Activity', html`<h1>Activity</h1>
<p class="lead">The last 100 calls, newest first.</p>
<div class="card">${table}</div>`)
}
