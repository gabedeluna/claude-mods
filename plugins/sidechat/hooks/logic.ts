// The side chat's plain logic: what it tells the forked model, how it reads lookup requests, follow-ups.

import type { SideEntry, SideRunning } from '../types'

export type Lookup =
  | { kind: 'read'; path: string; from?: number; to?: number }
  | { kind: 'search'; text: string; path?: string }
  | { kind: 'list'; path: string }
  | { kind: 'board'; query: string }
  | { kind: 'ledger' }

export const MAX_ROUNDS = 3

export const FOLLOW_UPS = [
  { key: 'simpler', label: 'Simpler', says: 'Say it more simply', ask: 'Say that again more simply, in fewer words.' },
  { key: 'example', label: 'Example', says: 'Give me an example', ask: 'Give one concrete example from this session that shows it.' },
  { key: 'why', label: 'Why?', says: 'Why is it that way?', ask: 'Why is it this way? What problem does it solve, and what would go wrong otherwise?' },
  { key: 'draw', label: 'Draw it', says: 'Draw it', ask: '' },
  { key: 'technical', label: 'Technical', says: 'The technical version, please', ask: 'Now the technical version: name the files, functions and mechanisms involved.' },
] as const

export const elapsed = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000))
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`
}

export const nowLine = (running: SideRunning | null, now: number) =>
  running ? `The main thread is running ${running.tool}: ${running.summary} (for ${elapsed(now - running.startedAt)}).` : 'The main thread is not running a tool right now.'

const HOW = [
  'SIDE CHAT. This message is not from the main conversation and the main thread will never see this exchange.',
  'The person is asking you ABOUT the conversation above, in a side panel. Do not continue the main task, do not act on anything above, and do not call tools: every tool is disabled here and a tool call fails.',
  'Answer in plain language: everyday words, no file paths, function names or code unless the person asks for the technical version. Short: a few sentences, or a few bullets for a recap.',
  'If you need to check something first, reply with ONLY lookup lines, one per line and nothing else:',
  '@read <path> [first-last]   a file, optionally a line range',
  '@search <text> [in <path>]  search the code',
  '@list <folder>              list a folder',
  '@board <card id or words>   look up the dev board',
  '@ledger                     this session\'s ledger',
  `The panel runs them and asks again with the results, ${MAX_ROUNDS} rounds at most. Paths are relative to the project root. Only look things up when the conversation does not already answer it.`,
  'When the person asks you to change the dev board, look the card up with @board first, then answer in a sentence and end your reply with a proposal, nothing after it:',
  '@board-edit',
  '{"ops":[ ... ]}',
  'Ops: move {id, status, log, plus trigger (backlog, ready) or nextAction (planning, building) or awaiting (review)} · log {id, text} · edit {id, set: {field: value}} · add {domain, id, type, title, note, status, its stage field, log} · link {id, kind, label, desc, url}.',
  'Log text starts with a tag (Decided:, Direction:, Found:, Fixed:, Built:). A decision of the person\'s quotes their own words: Decided: (their name) ... ("their words"). Plain sentences, no em dashes. Nothing changes until the person presses Approve, and you only propose: never claim the board changed.',
].join('\n')

export const WRITE_OPS = new Set(['add', 'move', 'log', 'fix-log', 'edit', 'link', 'open-campaign', 'close-campaign'])

export type Proposal = { ops: Record<string, unknown>[]; lines: string[] }

// A reply that ends in a board-edit block: the answer above it, and the ops as plain lines to approve.
export const parseProposal = (reply: string): { answer: string; proposal?: Proposal; error?: string } => {
  const m = /^[ \t]*@board-edit[ \t]*$/m.exec(reply)
  if (!m) return { answer: reply }
  const answer = reply.slice(0, m.index).trim()
  const raw = reply.slice(m.index + m[0].length).replace(/```(?:json)?/g, '').trim()
  try {
    const parsed = JSON.parse(raw) as unknown
    const list = Array.isArray(parsed) ? parsed : (parsed as { ops?: unknown })?.ops
    const ops = (Array.isArray(list) ? list : [list]).filter((o): o is Record<string, unknown> => !!o && typeof o === 'object')
    const bad = ops.find((o) => !WRITE_OPS.has(String(o.op)))
    if (!ops.length || bad) return { answer, error: bad ? `the side chat proposed "${String(bad.op)}", which is not a board change` : 'the proposal held no changes' }
    return { answer, proposal: { ops, lines: ops.map(describeOp) } }
  } catch {
    return { answer, error: 'the proposal could not be read' }
  }
}

const said = (v: unknown) => (typeof v === 'string' ? v : '')

// One board change in plain words, as the Approve card lists it.
export const describeOp = (o: Record<string, unknown>): string => {
  const id = said(o.id)
  switch (o.op) {
    case 'move':
      return `Move ${id} to ${said(o.status)}${o.log ? `, logging "${said(o.log)}"` : ''}`
    case 'log':
      return `Log on ${id}: "${said(o.text)}"`
    case 'fix-log':
      return `Rewrite the newest log entry on ${id}: "${said(o.text)}"`
    case 'edit': {
      const set = (o.set && typeof o.set === 'object' ? o.set : {}) as Record<string, unknown>
      return `Change ${id}: ${Object.entries(set).map(([k, v]) => (v === null ? `clear ${k}` : `${k} → "${String(v)}"`)).join(', ') || 'nothing'}`
    }
    case 'add':
      return `Add card ${id} to ${said(o.domain)} (${said(o.status) || 'backlog'}): "${said(o.title)}"`
    case 'link':
      return `Link "${said(o.label)}" on ${id}`
    case 'open-campaign':
      return `Open campaign ${id}: "${said(o.title)}"`
    case 'close-campaign':
      return `Close campaign ${id}`
    default:
      return `${String(o.op)} ${id}`
  }
}

export type PromptInput = {
  question: string
  history: SideEntry[]
  running: SideRunning | null
  now: number
  // Lookups already run for this question, with their results.
  looked?: { line: string; result: string }[]
  // The last round: answer with what you have.
  final?: boolean
}

export const buildPrompt = ({ question, history, running, now, looked = [], final }: PromptInput) => {
  const past = history.filter((h) => !h.failed).slice(-6)
  return [
    HOW,
    '',
    `Right now: ${nowLine(running, now)}`,
    ...(past.length ? ['', 'Earlier in this side chat:', ...past.map((h) => `Q: ${h.title}\nA: ${h.answer}${h.proposal ? `\n(Board change you proposed: ${h.proposal.status})` : ''}`)] : []),
    '',
    `Question: ${question}`,
    ...(looked.length ? ['', 'Lookups you asked for:', ...looked.map((l) => `${l.line}\n${l.result}`)] : []),
    ...(final ? ['', 'No more lookups: answer now with what you have, and say what you could not check.'] : []),
  ].join('\n')
}

const LOOKUP_LINE = /^@(read|search|list|board|ledger)\b\s*(.*)$/

// A reply made only of lookup lines is a request; anything else is the answer.
export const parseLookups = (reply: string): { lookups: Lookup[]; lines: string[] } | null => {
  const lines = reply.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
  if (!lines.length || !lines.every((l) => LOOKUP_LINE.test(l))) return null
  const lookups: Lookup[] = []
  for (const line of lines) {
    const [, verb, rest = ''] = LOOKUP_LINE.exec(line)!
    const arg = rest.trim()
    if (verb === 'ledger') lookups.push({ kind: 'ledger' })
    else if (verb === 'board' && arg) lookups.push({ kind: 'board', query: arg })
    else if (verb === 'list') lookups.push({ kind: 'list', path: arg || '.' })
    else if (verb === 'search' && arg) {
      const m = /^(.*?)\s+in\s+(\S+)$/.exec(arg)
      lookups.push(m ? { kind: 'search', text: unquote(m[1]!), path: m[2]! } : { kind: 'search', text: unquote(arg) })
    } else if (verb === 'read' && arg) {
      const m = /^(\S+)(?:\s+(\d+)\s*[-:]\s*(\d+))?$/.exec(arg)
      if (m) lookups.push({ kind: 'read', path: m[1]!, ...(m[2] ? { from: Number(m[2]), to: Number(m[3]) } : {}) })
    }
  }
  return lookups.length ? { lookups, lines } : null
}

const unquote = (s: string) => s.trim().replace(/^(["'`])(.*)\1$/, '$2')

// What the panel shows for a lookup while and after it runs.
export const lookupLabel = (l: Lookup) =>
  l.kind === 'read' ? `read ${l.path}${l.from ? ` ${l.from}-${l.to}` : ''}`
  : l.kind === 'search' ? `searched "${l.text}"${l.path ? ` in ${l.path}` : ''}`
  : l.kind === 'list' ? `listed ${l.path}`
  : l.kind === 'board' ? `looked up the board: ${l.query}`
  : 'read the ledger'

// Secrets stay out of the side chat.
export const isSecretPath = (p: string) => /(^|[\\/])\.env(\.|$)|(^|[\\/])\.env$|secrets?[\\/]|\.pem$|\.key$/i.test(p)

export const capText = (text: string, max = 12000) => (text.length > max ? `${text.slice(0, max)}\n[cut at ${max} characters]` : text)

export const sliceLines = (text: string, from?: number, to?: number, max = 400) => {
  const lines = text.split(/\r?\n/)
  const a = Math.max(1, from ?? 1)
  const b = Math.min(lines.length, to ?? a + max - 1, a + max - 1)
  const body = lines.slice(a - 1, b).map((l, i) => `${a + i}: ${l}`).join('\n')
  return b < lines.length && !to ? `${body}\n[${lines.length - b} more lines]` : body
}

export const recapQuestion = 'Recap this session so far for someone stepping back in: what was decided, what was built or changed, what is in progress right now, and what is still open or waiting on the person. Four to eight short bullets.'

export const nowQuestion = 'What is the main thread doing right now, and why? Say what step of the overall work this is, what it is waiting on, and what comes next.'

export const moreQuestion = (passage: string) => `Explain this passage from the conversation in more detail, so the person really understands it: «${passage.trim()}»`

export const sendToMainPrompt = (history: SideEntry[]) =>
  [
    'SIDE CHAT. Not from the main conversation; do not call tools.',
    'Below is a side chat the person had about this conversation. Write a short note, two to four sentences, that the person will put in their prompt to the main thread: what they learned or decided in the side chat that the main thread should know or act on. Write it as the person speaking to Claude, first person, plain words. Reply with the note only.',
    '',
    ...history.filter((h) => !h.failed).slice(-8).map((h) => `Q: ${h.title}\nA: ${h.answer}`),
  ].join('\n')

export const drawPrompt = (entry: SideEntry) =>
  [
    'SIDE CHAT. Not from the main conversation; do not call tools.',
    'Draw the idea in this side answer as one simple diagram. Reply with exactly two parts and nothing else:',
    'TITLE: a short title, at most six words',
    'SVG: one self-contained <svg> element with a viewBox, at most 720 wide, using currentColor for lines and text, at most two fill colors, font-family inherit, text at least 13px, no scripts, no external images.',
    '',
    `Question: ${entry.title}`,
    `Answer: ${entry.answer}`,
  ].join('\n')

export const parseDrawing = (reply: string): { title: string; svg: string } | null => {
  const title = /TITLE:\s*(.+)/.exec(reply)?.[1]?.trim()
  const svg = /<svg[\s\S]*?<\/svg>/i.exec(reply)?.[0]
  if (!title || !svg) return null
  if (/<script|on\w+\s*=|<foreignObject|href\s*=\s*["']?(?!#)/i.test(svg)) return null
  return { title: title.replace(/^["']|["']$/g, ''), svg }
}

// A themed page for the artifact: the diagram on a plain ground, light and dark.
export const drawingPage = (title: string, svg: string) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
:root{--bg:#faf9f5;--ink:#1f1e1b;--muted:#6b6860}
@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){--bg:#16181d;--ink:#e6e8ec;--muted:#8b929c}}
:root[data-theme="dark"]{--bg:#16181d;--ink:#e6e8ec;--muted:#8b929c}
body{margin:0;background:var(--bg);color:var(--ink);font-family:system-ui,sans-serif}
main{max-width:760px;margin:0 auto;padding:32px 16px}
h1{font-size:20px;margin:0 0 20px}
svg{width:100%;height:auto;color:var(--ink)}
p{color:var(--muted);font-size:13px}
</style>
</head>
<body>
<main>
<h1>${escapeHtml(title)}</h1>
${svg}
<p>Drawn by the side chat.</p>
</main>
</body>
</html>
`

const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

export const KIND_LABEL: Record<SideEntry['kind'], string> = {
  ask: 'QUESTION',
  recap: 'RECAP',
  now: 'NOW',
  more: 'MORE ON COPIED TEXT',
  followup: 'FOLLOW-UP',
}

// One line saying what a main-thread tool call is about.
export const summarizeCall = (tool: string, input: Record<string, unknown>) => {
  const s = (k: string) => (typeof input[k] === 'string' ? (input[k] as string) : '')
  const base = (p: string) => p.replace(/\\/g, '/').split('/').filter(Boolean).pop() ?? p
  const text =
    tool === 'Bash' || tool === 'PowerShell' ? s('description') || s('command')
    : ['Read', 'Write', 'Edit', 'MultiEdit'].includes(tool) ? base(s('file_path'))
    : tool === 'Grep' ? `"${s('pattern')}"`
    : tool === 'Agent' || tool === 'Task' ? s('description')
    : s('description') || s('command') || ''
  return text.replace(/\s+/g, ' ').trim().slice(0, 80)
}

// Claude Code's spinner frames, with * for ✳, which Windows draws as a green emoji square.
export const SPIN = ['·', '✢', '*', '✶', '✻', '✽', '✻', '✶', '*', '✢']
export const SPIN_MS = 120
export const spinFrame = (ms: number) => SPIN[Math.floor(Math.max(0, ms) / SPIN_MS) % SPIN.length]!
export const busyLabel = (busy: string) => busy.charAt(0).toUpperCase() + busy.slice(1)

// A finished board change in a line or two: what changed where, and only the notes that need a look.
export const boardOutcome = (p: { ops: Record<string, unknown>[]; status: string; result?: string }): string[] => {
  const cards = [...new Set(p.ops.map((o) => String(o.id ?? '')).filter(Boolean))]
  const n = p.ops.length
  const where = cards.length === 1 ? ` on ${cards[0]}` : cards.length ? ` across ${cards.length} cards` : ''
  const result = p.result ?? ''
  if (p.status === 'discarded') return [`▤ Board change discarded, nothing written`]
  if (p.status === 'failed') {
    const why = /REFUSED: (.+)/.exec(result)?.[1] ?? result.split('\n')[0] ?? ''
    return [`▤ Board change refused, nothing written`, ...(why ? [`  ${why.length > 140 ? `${why.slice(0, 137)}…` : why}`] : [])]
  }
  const notes: string[] = []
  const campaigns = [...result.matchAll(/Campaign (\S+) is open\./g)].map((m) => m[1]!)
  if (campaigns.length) notes.push(`  campaign ${campaigns.join(', ')}: its summary may need an update`)
  const warns = (result.match(/^WARN/gm) ?? []).length
  if (warns) notes.push(`  ${warns} new board warning${warns > 1 ? 's' : ''}`)
  return [`▤ Board changed: ${n} change${n > 1 ? 's' : ''}${where}`, ...notes]
}
