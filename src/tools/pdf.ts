import { PDFDocument } from 'pdf-lib'
import { z } from 'zod'
import { prune } from './prune.js'
import { defineTool, fileId, type ToolContext, ToolError } from './tool.js'

const mime = 'application/pdf'
const maxPages = 2000

export const pdfMerge = defineTool({
  id: 'pdf.merge',
  title: 'Merge PDFs',
  summary: 'Combine 2 to 50 PDFs into one, in the order given, up to 2000 pages. Form fields stay visible but cannot be edited.',
  tags: ['pdf', 'combine', 'join'],
  input: z.strictObject({
    files: z.array(fileId)
      .min(2)
      .max(50),
  }),
  example: { files: ['file_a', 'file_b'] },
  async run({ files }, context) {
    const merged = await PDFDocument.create()
    for (const id of files) {
      const source = await load(context, id)
      if (merged.getPageCount() + source.getPageCount() > maxPages) {
        throw new ToolError('too_many_pages', `the result would have more than ${maxPages} pages`)
      }
      await append(merged, source, source.getPageIndices())
    }
    return [{ name: 'merged.pdf', mime, data: await save(merged), pages: merged.getPageCount() }]
  },
})

export const pdfSplit = defineTool({
  id: 'pdf.split',
  title: 'Split a PDF',
  summary: 'Split a PDF into one file per page range. Form fields stay visible but cannot be edited.',
  tags: ['pdf', 'separate', 'extract', 'pages'],
  input: z.strictObject({
    file: fileId,
    ranges: z.array(z.string()
      .regex(/^\d{1,6}(-\d{1,6})?$/))
      .min(1)
      .max(100)
      .describe('Pages from 1, such as ["1-3", "4"]'),
  }),
  example: { file: 'file_a', ranges: ['1-3', '4'] },
  async run({ file, ranges }, context) {
    const source = await load(context, file)
    const parts = ranges.map((range) => ({ range, pages: pagesOf(range, source.getPageCount()) }))
    const outputs = []
    for (const { range, pages } of parts) {
      const part = await PDFDocument.create()
      await append(part, source, pages)
      outputs.push({ name: `pages-${range}.pdf`, mime, data: await save(part), pages: pages.length })
    }
    return outputs
  },
})

async function load(context: ToolContext, id: string) {
  const parsed = await parse(await context.read(id))
  if (!parsed || parsed.pages === 0) {
    throw new ToolError('not_a_pdf', `${id} is not a readable, unencrypted PDF with pages`)
  }
  const { document, pages } = parsed
  if (pages > maxPages) throw new ToolError('too_many_pages', `${id} has ${pages} pages; the limit is ${maxPages}`)
  return document
}

async function parse(bytes: Uint8Array) {
  try {
    const document = await PDFDocument.load(bytes)
    // A file without a page tree loads, then fails here.
    return { document, pages: document.getPageCount() }
  } catch {
    // Every parse failure, encryption included, has the same answer as a PDF without pages.
    return undefined
  }
}

async function append(target: PDFDocument, source: PDFDocument, indices: number[]) {
  for (const page of await target.copyPages(source, indices)) target.addPage(page)
}

async function save(document: PDFDocument) {
  prune(document)
  return document.save()
}

function pagesOf(range: string, count: number) {
  const [first = 0, last = first] = range.split('-')
    .map(Number)
  if (first < 1 || last < first || last > count) {
    throw new ToolError('bad_range', `range ${range} is not within pages 1-${count}`)
  }
  return Array.from({ length: last - first + 1 }, (_, offset) => first - 1 + offset)
}
