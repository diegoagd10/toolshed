import {
  PDFArray,
  PDFDict,
  type PDFDocument,
  PDFName,
  PDFNull,
  type PDFObject,
  PDFRef,
  PDFStream,
} from 'pdf-lib'

const type = PDFName.of('Type')
const page = PDFName.of('Page')
const subtype = PDFName.of('Subtype')
const widget = PDFName.of('Widget')
const destinationKey = PDFName.of('D')
const parent = PDFName.of('Parent')

// Copying a page also copies what its links and form fields point to, such as pages left out.
export function prune(document: PDFDocument) {
  const { context } = document
  const shown = new Set(document.getPages()
    .map(({ ref }) => ref))
  const kept = new Set<PDFRef>()
  const pending: (PDFObject | undefined)[] = [context.trailerInfo.Root, context.trailerInfo.Info]

  function isHiddenPage(value: PDFObject) {
    if (!(value instanceof PDFRef) || shown.has(value)) return false
    const target = context.lookup(value)
    return target instanceof PDFDict && target.get(type) === page
  }

  function leadsToHiddenPage(value: PDFObject): boolean {
    const target = context.lookup(value)
    if (target instanceof PDFArray) return target.size() > 0 && isHiddenPage(target.get(0))
    const destination = target instanceof PDFDict && target.get(destinationKey)
    return destination ? leadsToHiddenPage(destination) : false
  }

  function isLost(value: PDFObject) {
    return isHiddenPage(value) || context.lookup(value) === undefined
  }

  while (pending.length > 0) {
    const object = pending.pop()
    if (object instanceof PDFRef) {
      if (kept.has(object)) continue
      kept.add(object)
      pending.push(context.lookup(object))
    } else if (object instanceof PDFArray) {
      for (const [index, value] of object.asArray()
        .entries()) {
        if (isLost(value)) object.set(index, PDFNull)
        else pending.push(value)
      }
    } else if (object instanceof PDFDict || object instanceof PDFStream) {
      const dict = object instanceof PDFDict ? object : object.dict
      const isWidget = dict.get(subtype) === widget
      for (const [key, value] of dict.entries()) {
        const isField = isWidget && key === parent
        if (isField || isLost(value) || leadsToHiddenPage(value)) dict.delete(key)
        else pending.push(value)
      }
    }
  }

  for (const [ref] of context.enumerateIndirectObjects()) {
    if (!kept.has(ref)) context.delete(ref)
  }
}
