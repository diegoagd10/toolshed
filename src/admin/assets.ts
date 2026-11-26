// Served as files, so the Content-Security-Policy can refuse every inline style and script.
export const css = `:root {
  color-scheme: light dark;
  --bg: #f6f4ef; --card: #fffdf9; --ink: #1d2422; --muted: #5f6b66; --line: #ddd6c8;
  --accent: #b4410f; --ok: #17733a; --code: #efe9dc;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #161a19; --card: #1e2321; --ink: #e9ece9; --muted: #9aa5a0; --line: #343b38;
    --accent: #f08a4b; --ok: #5fc985; --code: #262c2a;
  }
}
* { box-sizing: border-box }
body { margin: 0; background: var(--bg); color: var(--ink); font: 15px/1.5 system-ui, sans-serif }
a { color: inherit }
header { display: flex; flex-wrap: wrap; gap: 4px 20px; align-items: center; padding: 14px 16px;
  border-bottom: 1px solid var(--line) }
header .brand { font-weight: 700; font-size: 18px; margin-right: auto }
header nav { display: flex; flex-wrap: wrap; gap: 4px 16px; align-items: center }
header nav a { color: var(--muted); text-decoration: none; padding: 4px 0 }
header nav a[aria-current=page] { color: var(--accent); font-weight: 600 }
header form { margin: 0 }
main { max-width: 880px; margin: 24px auto 48px; padding: 0 16px }
h1 { font-size: 24px; margin: 0 0 4px }
h2 { font-size: 16px; margin: 0 0 8px }
p { margin: 0 0 12px }
.lead { color: var(--muted); margin-bottom: 20px }
.card { background: var(--card); border: 1px solid var(--line); border-radius: 8px; padding: 16px;
  margin-bottom: 12px; overflow-wrap: anywhere }
.card.new { border-color: var(--ok) }
code, pre { background: var(--code); border-radius: 4px; font: 13px/1.5 ui-monospace, monospace }
code { padding: 2px 6px }
pre { padding: 10px 12px; margin: 0; white-space: pre-wrap; overflow-wrap: anywhere }
.copy { display: flex; gap: 8px; align-items: flex-start }
.copy pre { flex: 1; min-width: 0 }
button, input { font: inherit }
button { border: 0; border-radius: 6px; padding: 8px 14px; background: var(--ink); color: var(--bg);
  cursor: pointer; white-space: nowrap }
button.link { background: none; color: var(--muted); padding: 4px 0; border-radius: 0 }
button.quiet { background: none; color: var(--ink); border: 1px solid var(--line) }
button.danger { background: none; color: var(--accent); border: 1px solid var(--accent) }
label { display: block; font-weight: 600; margin-bottom: 4px }
input { width: 100%; padding: 8px 10px; border: 1px solid var(--line); border-radius: 6px;
  background: var(--bg); color: var(--ink) }
.field { display: flex; gap: 8px; align-items: flex-end; flex-wrap: wrap }
.field > div { flex: 1 1 220px }
.error { color: var(--accent); font-weight: 600 }
.muted { color: var(--muted) }
.ok { color: var(--ok) }
.login { max-width: 360px; margin: 12vh auto 0 }
.login button { width: 100%; margin-top: 12px }
table { width: 100%; border-collapse: collapse }
th, td { text-align: left; padding: 8px 6px; border-bottom: 1px solid var(--line); font-size: 14px;
  vertical-align: middle }
th { color: var(--muted); font-weight: 600 }
td form { margin: 0 }
@media (max-width: 640px) {
  thead { display: none }
  table, tbody, tr, td { display: block }
  tr { padding: 8px 0; border-bottom: 1px solid var(--line) }
  td { border: 0; padding: 2px 0; display: flex; gap: 12px }
  td::before { content: attr(data-label); color: var(--muted); min-width: 84px }
}
`

export const js = `for (const button of document.querySelectorAll('[data-copy]')) {
  button.addEventListener('click', async () => {
    const text = document.getElementById(button.dataset.copy).textContent
    await navigator.clipboard.writeText(text)
    button.textContent = 'Copied'
  })
}
`
