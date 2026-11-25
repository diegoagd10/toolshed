import { Byte, Charset, Encoder, type Encoded } from '@nuintun/qrcode'
import { PNG } from 'pngjs'
import { z } from 'zod'
import { defineTool } from './tool.js'

const quietZone = 4
const minScale = 2
const maxBytes = 2330

export const qrCreate = defineTool({
  id: 'qr.create',
  title: 'Create a QR code',
  summary: 'Turn text or a URL into a PNG or SVG QR code.',
  tags: ['qr', 'barcode', 'image'],
  input: z.strictObject({
    text: z.string()
      .min(1)
      .max(2000)
      .refine((text) => Buffer.byteLength(text) <= maxBytes, `must be at most ${maxBytes} bytes`),
    format: z.enum(['png', 'svg'])
      .default('png'),
    size: z.int()
      .min(64)
      .max(2048)
      .default(512)
      .describe('Width in pixels. A PNG comes out larger when the text does not fit'),
  }),
  example: { text: 'https://example.com' },
  async run({ text, format, size }) {
    const code = encode(text)
    return format === 'svg'
      ? [{ name: 'qr.svg', mime: 'image/svg+xml', data: Buffer.from(svg(code, size)) }]
      : [{ name: 'qr.png', mime: 'image/png', data: png(code, size) }]
  },
})

// Only non-ASCII text declares UTF-8, because readers otherwise guess the encoding.
function encode(text: string) {
  const charset = Buffer.byteLength(text) === text.length ? Charset.ISO_8859_1 : Charset.UTF_8
  return new Encoder({ level: 'M' })
    .encode(new Byte(text, charset))
}

function svg(code: Encoded, size: number) {
  const width = code.size + 2 * quietZone
  let path = ''
  for (let y = 0; y < code.size; y++) {
    for (let x = 0; x < code.size; x++) {
      if (code.get(x, y)) path += `M${x + quietZone} ${y + quietZone}h1v1h-1z`
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${width} ${width}" shape-rendering="crispEdges"><path fill="#fff" d="M0 0h${width}v${width}H0z"/><path d="${path}"/></svg>`
}

function png(code: Encoded, size: number) {
  const modules = code.size + 2 * quietZone
  const scale = Math.max(minScale, Math.floor(size / modules))
  const width = Math.max(size, modules * scale)
  const start = Math.floor((width - code.size * scale) / 2)
  const image = new PNG({ width, height: width })
  image.data.fill(255)
  for (let y = 0; y < code.size * scale; y++) {
    for (let x = 0; x < code.size * scale; x++) {
      if (!code.get(Math.floor(x / scale), Math.floor(y / scale))) continue
      const offset = ((start + y) * width + start + x) * 4
      image.data.fill(0, offset, offset + 3)
    }
  }
  return PNG.sync.write(image, { colorType: 0 })
}
