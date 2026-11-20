/**
 * Newline normalization for text taken from PDFs, Word and terminals.
 * Pure functions only: no I/O, no model calls, deterministic and unit-tested.
 */

const CJK = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/

/** Shapes that must never be joined: line breaks carry meaning there. */
const SHAPES = Object.freeze({ PROSE: 'prose', CODE: 'code', LIST: 'list', TABLE: 'table', EMPTY: 'empty' })

/**
 * Classify a selection so the caller can decide whether joining lines is safe.
 * @param text - text after newline unification.
 * @returns one of `code`, `list`, `table`, `prose`, `empty`.
 */
export function detectShape(text) {
  const lines = text.split('\n').filter((line) => line.trim() !== '')
  if (lines.length === 0) return SHAPES.EMPTY
  if (lines.length === 1) return SHAPES.PROSE
  if (/```/.test(text)) return SHAPES.CODE

  let indented = 0
  let dense = 0
  let listy = 0
  let tabley = 0
  for (const line of lines) {
    if (/^(?:\t| {2,})\S/.test(line)) indented += 1
    const symbols = (line.match(/[{};=()<>[\]]/g) ?? []).length
    if (symbols / Math.max(1, line.length) > 0.08) dense += 1
    if (/^\s*(?:[-*•·–]|\d+[.)]|[①-⑩])\s+/.test(line)) listy += 1
    if (/\S {2,}\S/.test(line)) tabley += 1
  }

  const total = lines.length
  // Two lines are far more often a wrapped sentence than code; demand evidence.
  if (total >= 3) {
    if (indented / total > 0.4) return SHAPES.CODE
    if (dense / total > 0.5) return SHAPES.CODE
    if (listy / total > 0.4) return SHAPES.LIST
    if (tabley / total > 0.5) return SHAPES.TABLE
  } else if (listy === total) {
    return SHAPES.LIST
  }
  return SHAPES.PROSE
}

/** Join one paragraph: no space between CJK neighbours, one space otherwise. */
function joinBlock(lines, stats) {
  let out = ''
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim()
    if (index > 0) {
      const previous = out.slice(-1)
      const next = line.charAt(0)
      const bothCjk = previous !== '' && next !== '' && CJK.test(previous) && CJK.test(next)
      if (!bothCjk) out += ' '
      stats.newlines += 1
    }
    out += line
  }
  return out.replace(/ {2,}/g, ' ').trim()
}

/**
 * Normalize raw selected text for sending to a model.
 * @param input - raw text from the clipboard.
 * @param options.mode - `auto` decides by shape, `on` forces joining, `off` keeps breaks.
 * @returns the normalized text plus a shape verdict and counters the UI can show.
 */
export function normalize(input, { mode = 'auto' } = {}) {
  const stats = { newlines: 0, hyphens: 0, stripped: 0, forcedSkip: null }
  const raw = String(input ?? '')
  if (raw.trim() === '') {
    return { text: '', shape: SHAPES.EMPTY, applied: false, stats }
  }

  // 1. Unify every line-break flavour a clipboard may carry.
  let text = raw.replace(/\r\n?/g, '\n').replace(/[\v\u2028\u2029]/g, '\n')

  // 2. Drop invisible characters that break token matching.
  const before = text.length
  text = text
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/\u00A0/g, ' ')
    .replace(/\u3000/g, ' ')
  stats.stripped = before - text.length

  const shape = detectShape(text)
  if (mode === 'off' || shape === SHAPES.EMPTY) {
    return { text: text.trim(), shape, applied: false, stats }
  }

  // Line breaks are load-bearing here; report why nothing was merged.
  if (shape !== SHAPES.PROSE) {
    if (mode === 'on') stats.forcedSkip = shape
    return { text: text.trim(), shape, applied: false, stats }
  }

  // 3. Repair words hyphenated across a line break.
  text = text.replace(/(\p{L})-\n(\p{L})/gu, (_match, head, tail) => {
    stats.hyphens += 1
    return `${head}${tail}`
  })

  // 4. Join inside paragraphs only; blank lines keep the paragraph structure.
  const blocks = text.split(/\n{2,}/).map((block) => block.trim()).filter((block) => block !== '')
  const joined = blocks.map((block) => joinBlock(block.split('\n'), stats)).join('\n\n')

  return { text: joined, shape, applied: true, stats }
}

/**
 * Split text that exceeds the model's per-request limit.
 * @param text - normalized text.
 * @param limit - maximum characters per request.
 * @returns chunks that prefer sentence boundaries.
 */
export function segment(text, limit) {
  if (!Number.isFinite(limit) || limit <= 0 || text.length <= limit) return [text]
  const chunks = []
  let rest = text
  while (rest.length > limit) {
    let cut = limit
    const window = rest.slice(0, cut)
    const boundary = Math.max(
      window.lastIndexOf('。'), window.lastIndexOf('！'), window.lastIndexOf('？'),
      window.lastIndexOf('. '), window.lastIndexOf('! '), window.lastIndexOf('? '),
      window.lastIndexOf('\n'),
    )
    if (boundary > limit * 0.4) cut = boundary + 1
    // Never split a surrogate pair.
    if (/[\uD800-\uDBFF]/.test(rest.charAt(cut - 1))) cut -= 1
    chunks.push(rest.slice(0, cut))
    rest = rest.slice(cut)
  }
  if (rest !== '') chunks.push(rest)
  return chunks
}

export { SHAPES }