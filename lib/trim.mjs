// HTML to plain text, small enough to put in a prompt.
//
// The cap is the point. A 500KB page and a 2KB page must produce the same size
// prompt, or one bloated homepage quietly costs more than a day of sourcing.

export const MAX_CHARS = 7000

const DROP_BLOCKS = /<(script|style|noscript|svg|template|nav|footer|header|aside)\b[^>]*>[\s\S]*?<\/\1>/gi
// An unclosed <script> would otherwise leak its whole body through as text.
const DROP_OPEN_TAIL = /<(script|style)\b[^>]*>[\s\S]*$/i

const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'", '#x27': "'",
}

export function trim(html, max = MAX_CHARS) {
  if (!html) return ''
  let text = String(html)
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(DROP_BLOCKS, ' ')
    .replace(DROP_OPEN_TAIL, ' ')
    // Block-level tags become breaks so words on separate lines do not fuse.
    .replace(/<\/(p|div|li|tr|h[1-6]|section|article|br)\s*>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&([a-z]+|#x?[0-9a-f]+);/gi, (m, e) => ENTITIES[e.toLowerCase()] ?? ' ')
    .replace(/[ \t ]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()

  return text.length > max ? text.slice(0, max) : text
}
