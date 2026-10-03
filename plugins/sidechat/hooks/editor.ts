// The side chat's message box, as plain rules: the text, where the cursor is, what each key does,
// and how the text wraps into the box's width. The box module draws what these return.

export type Ed = { text: string; cursor: number }
export type Key = { key: string; ctrl?: true; shift?: true; meta?: true }

export const EMPTY: Ed = { text: '', cursor: 0 }

const NAMED = new Set([
  'up', 'down', 'left', 'right', 'return', 'enter', 'tab', 'backspace', 'delete', 'pageup', 'pagedown',
  'home', 'end', 'escape', 'insert', 'space',
])
const isNamed = (k: string) => NAMED.has(k) || /^f\d{1,2}$/.test(k)

const clamp = (ed: Ed, cursor: number): Ed => ({ text: ed.text, cursor: Math.max(0, Math.min(ed.text.length, cursor)) })

export const insert = (ed: Ed, s: string): Ed => {
  const t = s.replace(/\r\n?/g, '\n').replace(/\t/g, '  ')
  return { text: ed.text.slice(0, ed.cursor) + t + ed.text.slice(ed.cursor), cursor: ed.cursor + t.length }
}

const remove = (ed: Ed, from: number, to: number): Ed => {
  const a = Math.max(0, Math.min(from, to))
  const b = Math.min(ed.text.length, Math.max(from, to))
  return { text: ed.text.slice(0, a) + ed.text.slice(b), cursor: a }
}

const wordStart = (text: string, i: number) => {
  let j = i
  while (j > 0 && /\s/.test(text[j - 1]!)) j -= 1
  while (j > 0 && !/\s/.test(text[j - 1]!)) j -= 1
  return j
}

const wordEnd = (text: string, i: number) => {
  let j = i
  while (j < text.length && /\s/.test(text[j]!)) j += 1
  while (j < text.length && !/\s/.test(text[j]!)) j += 1
  return j
}

export type Line = { start: number; end: number; last: boolean }

// Wraps at spaces where it can, inside a word where it must; line breaks always start a new line.
export const wrap = (text: string, width: number): Line[] => {
  const w = Math.max(1, width)
  const lines: Line[] = []
  let ls = 0
  for (;;) {
    const nl = text.indexOf('\n', ls)
    const le = nl === -1 ? text.length : nl
    let pos = ls
    while (le - pos > w) {
      const space = text.lastIndexOf(' ', pos + w)
      const brk = space >= pos && space < pos + w + 1 && space > pos ? space + 1 : pos + w
      lines.push({ start: pos, end: brk, last: false })
      pos = brk
    }
    lines.push({ start: pos, end: le, last: true })
    if (nl === -1) break
    ls = nl + 1
  }
  return lines
}

// Which wrapped line and column the cursor sits on.
export const cursorAt = (lines: Line[], cursor: number) => {
  for (let row = 0; row < lines.length; row += 1) {
    const l = lines[row]!
    if (cursor >= l.start && (cursor < l.end || (cursor === l.end && l.last))) return { row, col: cursor - l.start }
  }
  const l = lines.at(-1)!
  return { row: lines.length - 1, col: l.end - l.start }
}

const vertical = (ed: Ed, width: number, dir: -1 | 1): Ed => {
  const lines = wrap(ed.text, width)
  const { row, col } = cursorAt(lines, ed.cursor)
  const target = lines[row + dir]
  if (!target) return clamp(ed, dir < 0 ? 0 : ed.text.length)
  return clamp(ed, target.start + Math.min(col, target.end - target.start))
}

const lineEdge = (ed: Ed, width: number, edge: 'start' | 'end'): Ed => {
  const lines = wrap(ed.text, width)
  const l = lines[cursorAt(lines, ed.cursor).row]!
  return clamp(ed, edge === 'start' ? l.start : l.end)
}

// One key: the box after it, and the text to send when it was Enter on a message.
export const applyKey = (ed: Ed, k: Key, width: number): { ed: Ed; submit?: string } => {
  const key = k.key
  if (key === 'return' || key === 'enter') {
    if (k.shift || k.meta) return { ed: insert(ed, '\n') }
    // As in the main prompt: a backslash before Enter makes a line break.
    if (ed.cursor > 0 && ed.text[ed.cursor - 1] === '\\') return { ed: insert(remove(ed, ed.cursor - 1, ed.cursor), '\n') }
    return ed.text.trim() ? { ed: EMPTY, submit: ed.text.trim() } : { ed }
  }
  if (k.ctrl) {
    if (key === 'a') return { ed: lineEdge(ed, width, 'start') }
    if (key === 'e') return { ed: lineEdge(ed, width, 'end') }
    if (key === 'u') return { ed: remove(ed, lineEdge(ed, width, 'start').cursor, ed.cursor) }
    if (key === 'k') return { ed: remove(ed, ed.cursor, lineEdge(ed, width, 'end').cursor) }
    if (key === 'w' || key === 'backspace') return { ed: remove(ed, wordStart(ed.text, ed.cursor), ed.cursor) }
    if (key === 'left') return { ed: clamp(ed, wordStart(ed.text, ed.cursor)) }
    if (key === 'right') return { ed: clamp(ed, wordEnd(ed.text, ed.cursor)) }
    return { ed }
  }
  switch (key) {
    case 'backspace':
      return { ed: ed.cursor ? remove(ed, ed.cursor - 1, ed.cursor) : ed }
    case 'delete':
      return { ed: remove(ed, ed.cursor, ed.cursor + 1) }
    case 'left':
      return { ed: clamp(ed, ed.cursor - 1) }
    case 'right':
      return { ed: clamp(ed, ed.cursor + 1) }
    case 'up':
      return { ed: vertical(ed, width, -1) }
    case 'down':
      return { ed: vertical(ed, width, 1) }
    case 'home':
      return { ed: lineEdge(ed, width, 'start') }
    case 'end':
      return { ed: lineEdge(ed, width, 'end') }
    case 'space':
      return { ed: insert(ed, ' ') }
    case 'tab':
      return { ed: insert(ed, '  ') }
  }
  if (isNamed(key)) return { ed }
  // One character typed, or a whole paste arriving as one key.
  return { ed: insert(ed, key) }
}
