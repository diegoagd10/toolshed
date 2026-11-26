// The only way to make an Html value is the html tag, so every other value is escaped.
export class Html {
  readonly value: string

  constructor(value: string) {
    this.value = value
  }
}

type Part = Html | Part[] | string | number | false

function render(part: Part): string {
  if (part instanceof Html) return part.value
  if (Array.isArray(part)) return part.map(render)
    .join('')
  if (part === false) return ''
  return String(part)
    .replace(/[&<>"'`]/g, (character) => `&#${character.charCodeAt(0)};`)
}

export function html(strings: TemplateStringsArray, ...parts: Part[]) {
  const [first, ...rest] = strings
  const joined = rest.reduce((out, text, index) => out + render(parts[index] as Part) + text, first)
  return new Html(String(joined))
}
