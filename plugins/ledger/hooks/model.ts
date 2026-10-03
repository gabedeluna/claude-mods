import type {
  LedgerBoard,
  LedgerCard,
  LedgerDoc,
  LedgerItem,
  LedgerOwner,
  LedgerRuling,
  LedgerStatus,
  LedgerTopic,
} from '../types'

export const STATUSES: LedgerStatus[] = [
  'now',
  'exploring',
  'shaped',
  'chosen',
  'hold',
  'rejected',
  'review',
  'done',
]

export type LedgerOp = {
  op: string
  topic?: string
  text?: string
  quote?: string
  owner?: string
  detail?: string
  rec?: string
  item?: string
  status?: string
  card?: string
  exempt?: boolean
  evidence?: string
  agent?: string
  task?: string
  change?: string
  content?: string
  tasks?: string
}

export type Gap = { topicId: string; itemId?: string; text: string }

export const emptyDoc = (): LedgerDoc => ({ v: 1, title: '', topics: [], updatedTurn: 0 })

export const slug = (name: string): string =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32) || 'topic'

// Lowercase, straight quotes gone, whitespace collapsed: what a quote check compares.
export const norm = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[“”‘’"'`]/g, '')
    .replace(/\s+/g, ' ')
    .trim()

// A quote may skip words with "..." between fragments; every fragment must be in one user message.
export const quoteFragments = (quote: string): string[] =>
  quote
    .split(/\.\.\.|…/)
    .map(norm)
    .filter((f) => f.length > 0)

export const quoteIsVerbatim = (quote: string, userTexts: string[]): boolean => {
  const frags = quoteFragments(quote)
  if (frags.length === 0) return false
  const texts = userTexts.map(norm)
  return texts.some((t) => frags.every((f) => t.includes(f)))
}

const clone = (doc: LedgerDoc): LedgerDoc => JSON.parse(JSON.stringify(doc)) as LedgerDoc

export const findTopic = (doc: LedgerDoc, ref: string): LedgerTopic | undefined => {
  const r = ref.trim().toLowerCase()
  return doc.topics.find((t) => t.id === r || t.name.toLowerCase() === r || t.id === slug(ref))
}

export const findItem = (
  doc: LedgerDoc,
  id: string,
): { topic: LedgerTopic; item: LedgerItem } | undefined => {
  for (const topic of doc.topics) {
    const item = topic.items.find((i) => i.id === id.trim())
    if (item) return { topic, item }
  }
  return undefined
}

// Topic names start with a letter: the name leads text put in the prompt box, where a leading / reads as a command.
export const cleanName = (s: string): string => s.trim().replace(/^[^\p{L}]+/u, '')

// An item named by its task number inside a topic ("3.4" in the thread topic).
export const findByTask = (
  doc: LedgerDoc,
  topicRef: string,
  task: string,
): { topic: LedgerTopic; item: LedgerItem } | undefined => {
  const topic = findTopic(doc, topicRef)
  const item = topic?.items.find((i) => i.kind === 'todo' && i.task === task)
  return topic && item ? { topic, item } : undefined
}

// "3.4 Notice step ..." starts with a task number; "Build the panel" does not.
export const leadingTaskNumber = (text: string): string | undefined => /^(\d+(?:\.\d+)?[a-z]?)\s/.exec(text)?.[1]

// The next ordinal under an agent's name in a topic: 1, 2, 3 in the order the steps were added.
const nextOrdinal = (topic: LedgerTopic, agent: string): string =>
  String(topic.items.filter((i) => i.kind === 'todo' && i.agent === agent).length + 1)

// A row title from a tasks.md line: backticks gone, paths cut to their last segment, the first
// clause only (up to ". ", "; " or " ("), capped at a word boundary. The full text stays in `full`.
export const shortTitle = (text: string, max = 64): string => {
  let t = text
    .replace(/`/g, '')
    .replace(/\S*\/\S*/g, (m) => m.replace(/\/+$/, '').split('/').pop() ?? m)
    .replace(/\s{2,}/g, ' ')
    .trim()
  const cut = t.search(/\. |; | \(/)
  if (cut > 8) t = t.slice(0, cut)
  t = t.replace(/[:,;]\s*$/, '').trim()
  if (t.length <= max) return t
  const head = t.slice(0, max - 1)
  const space = head.lastIndexOf(' ')
  return `${(space > max / 2 ? head.slice(0, space) : head).trim()}…`
}

// Natural order of step numbers: 0.1, 0.2, 2.1, 3.1, 3.1a, 3.2, 10.1; a step without a number sorts last.
export const compareTasks = (a: string | undefined, b: string | undefined): number => {
  if (a === b) return 0
  if (a === undefined) return 1
  if (b === undefined) return -1
  const pa = a.split('.')
  const pb = b.split('.')
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const [na, sa] = /^(\d+)([a-z]*)$/.exec(pa[i] ?? '')?.slice(1) ?? ['-1', '']
    const [nb, sb] = /^(\d+)([a-z]*)$/.exec(pb[i] ?? '')?.slice(1) ?? ['-1', '']
    if (Number(na) !== Number(nb)) return Number(na) - Number(nb)
    if (sa !== sb) return (sa ?? '') < (sb ?? '') ? -1 : 1
  }
  return 0
}

export type ParsedTask = { number: string; text: string; done: boolean }

// The checkbox lines of an OpenSpec tasks.md: "- [ ] 3.4 text" and "- [x] 1.1 text".
export const parseTasks = (content: string): ParsedTask[] => {
  const out: ParsedTask[] = []
  for (const raw of content.split(/\r?\n/)) {
    const m = /^\s*-\s*\[( |x|X)\]\s*(\d+(?:\.\d+)?[a-z]?)\s+(.*)$/.exec(raw)
    if (!m) continue
    out.push({ number: m[2]!, text: m[3]!.trim(), done: m[1] !== ' ' })
  }
  return out
}

// What a dispatched agent reads at the end of its prompt: its open steps and how to close them.
export const agentBrief = (doc: LedgerDoc, agent: string): string | null => {
  const rows: string[] = []
  for (const t of doc.topics) {
    if (t.status === 'done' || t.status === 'rejected') continue
    for (const i of t.items) if (i.kind === 'todo' && i.agent === agent && !i.done) rows.push(`  - ${i.id}: ${i.task ? `${i.task} ` : ''}${i.full ?? i.text}`)
  }
  if (!rows.length) return null
  return [
    `Session ledger steps assigned to you (@${agent}). The user follows your progress through them.`,
    'Close each one the moment it lands, before starting the next, with the tool mcp__ledger__ledger:',
    '  {"ops":[{"op":"close","item":"<id>","evidence":"<what ran and what it showed>"}]}',
    'Never batch the closes at the end. A step you will not do stays open: say so in your report.',
    ...rows,
  ].join('\n')
}

export const stepText = (i: LedgerItem): string => (i.task ? `${i.task} ${i.text}` : i.text)

const ensureTopic = (doc: LedgerDoc, ref: string): LedgerTopic => {
  const found = findTopic(doc, ref)
  if (found) return found
  let id = slug(ref)
  while (doc.topics.some((t) => t.id === id)) id = `${id}-2`
  const topic: LedgerTopic = { id, name: cleanName(ref), status: 'exploring', seq: 0, items: [] }
  doc.topics.push(topic)
  return topic
}

const addItem = (topic: LedgerTopic, item: Omit<LedgerItem, 'id'>, turn?: number): LedgerItem => {
  topic.seq += 1
  const made = { id: `${topic.id}.${topic.seq}`, ...item, ...(turn === undefined ? {} : { turn }) } as LedgerItem
  topic.items.push(made)
  return made
}

const owner = (o: string | undefined): LedgerOwner | undefined =>
  o === 'you' || o === 'claude' ? o : undefined

export type ApplyContext = { userTexts: string[]; turn: number }
export type ApplyResult = { doc: LedgerDoc; done: string[]; failed: string[]; changed: boolean }

export const applyOps = (start: LedgerDoc, ops: LedgerOp[], ctx: ApplyContext): ApplyResult => {
  const doc = clone(start)
  const done: string[] = []
  const failed: string[] = []
  const need = (o: LedgerOp, ...fields: (keyof LedgerOp)[]): string | undefined => {
    const missing = fields.filter((f) => o[f] === undefined || o[f] === '')
    return missing.length ? `${o.op}: needs ${missing.join(', ')}` : undefined
  }

  for (const o of ops) {
    const miss = (() => {
      switch (o.op) {
        case 'topic':
          return need(o, 'topic')
        case 'decide':
          return need(o, 'topic', 'text', 'quote')
        case 'answer':
          return need(o, 'item', 'text', 'quote')
        case 'ask':
        case 'todo':
          return need(o, 'topic', 'text', 'owner')
        case 'learn':
          return need(o, 'topic', 'text')
        case 'close':
        case 'reopen':
        case 'remove':
        case 'logged':
        case 'edit':
          return o.topic && o.task ? undefined : need(o, 'item')
        case 'tasks':
          return need(o, 'topic', 'change')
        case 'assign':
          return need(o, 'agent')
        case 'hold':
        case 'title':
          return undefined
        default:
          return `unknown op "${o.op}"`
      }
    })()
    if (miss) {
      failed.push(miss)
      continue
    }
    if (o.topic !== undefined && !findTopic(doc, o.topic) && !cleanName(o.topic)) {
      failed.push(`${o.op}: topic names must start with a letter ("${o.topic}")`)
      continue
    }

    if (o.op === 'title') {
      doc.title = (o.text ?? '').trim()
      done.push(`title set`)
      continue
    }
    if (o.op === 'hold') {
      doc.hold = o.text?.trim() || undefined
      done.push(doc.hold ? 'hold set' : 'hold cleared')
      continue
    }

    if (o.op === 'topic') {
      const topic = ensureTopic(doc, o.topic!)
      if (o.status) {
        if (!STATUSES.includes(o.status as LedgerStatus)) {
          failed.push(`topic: status must be one of ${STATUSES.join(', ')}`)
          continue
        }
        // Only one topic is "now" at a time.
        if (o.status === 'now') {
          for (const t of doc.topics) if (t !== topic && t.status === 'now') t.status = 'shaped'
        }
        topic.status = o.status as LedgerStatus
      }
      if (o.text) {
        if (!cleanName(o.text)) {
          failed.push(`topic: the name "${o.text}" has no letters to start with`)
          continue
        }
        topic.name = cleanName(o.text)
      }
      if (o.card !== undefined) topic.card = o.card.trim() || undefined
      if (o.exempt !== undefined) topic.exempt = o.exempt
      done.push(`topic ${topic.id}`)
      continue
    }

    if (o.op === 'decide') {
      if (!quoteIsVerbatim(o.quote!, ctx.userTexts)) {
        failed.push(
          `decide "${o.text}": the quote is not in any user message. Record it with op ask (owner you) as a recommendation until the user rules in their own words.`,
        )
        continue
      }
      const topic = ensureTopic(doc, o.topic!)
      const made = addItem(topic, { kind: 'decided', text: o.text!.trim(), quote: o.quote!.trim() })
      done.push(`${made.id} decided (quote verified)`)
      continue
    }

    if (o.op === 'ask' || o.op === 'todo') {
      const who = owner(o.owner)
      if (!who) {
        failed.push(`${o.op}: owner must be you or claude`)
        continue
      }
      const topic = ensureTopic(doc, o.topic!)
      const agent = o.op === 'todo' ? o.agent?.trim() || undefined : undefined
      const text = o.text!.trim()
      // A step under an agent's name carries its number: the task number the text starts
      // with, or the next ordinal under that agent in this topic.
      const task = agent ? o.task?.trim() || leadingTaskNumber(text) || nextOrdinal(topic, agent) : o.task?.trim() || undefined
      const made = addItem(topic, {
        kind: o.op === 'ask' ? 'question' : 'todo',
        text: task && text.startsWith(`${task} `) ? text.slice(task.length + 1).trim() : text,
        owner: who,
        detail: o.detail?.trim() || undefined,
        rec: o.op === 'ask' ? o.rec?.trim() || undefined : undefined,
        ...(agent ? { agent } : {}),
        ...(task ? { task } : {}),
      }, ctx.turn)
      done.push(`${made.id} ${made.kind} for ${who}${agent ? ` (${task} @${agent})` : ''}`)
      continue
    }

    if (o.op === 'tasks') {
      const miss = need(o, 'topic', 'change')
      if (miss) {
        failed.push(miss)
        continue
      }
      if (o.content === undefined) {
        failed.push(`tasks: could not read tasks.md for change ${o.change}`)
        continue
      }
      const topic = ensureTopic(doc, o.topic!)
      topic.change = o.change!.trim()
      const only = o.tasks ? new Set(o.tasks.split(',').map((t) => t.trim()).filter(Boolean)) : null
      const agent = o.agent?.trim() || undefined
      let loaded = 0
      let skipped = 0
      for (const t of parseTasks(o.content)) {
        if (only && !only.has(t.number)) continue
        if (t.done || topic.items.some((i) => i.kind === 'todo' && i.task === t.number)) {
          skipped += 1
          continue
        }
        addItem(topic, { kind: 'todo', text: shortTitle(t.text), full: t.text, owner: 'claude', task: t.number, ...(agent ? { agent } : {}) }, ctx.turn)
        loaded += 1
      }
      done.push(`${topic.id}: loaded ${loaded} step${loaded === 1 ? '' : 's'} from ${o.change}/tasks.md${agent ? ` for @${agent}` : ''}${skipped ? ` (${skipped} already done or present)` : ''}`)
      continue
    }

    if (o.op === 'assign') {
      const miss = need(o, 'agent')
      if (miss) {
        failed.push(miss)
        continue
      }
      const hits = o.item
        ? [findItem(doc, o.item)]
        : o.topic && o.tasks
          ? o.tasks.split(',').map((t) => findByTask(doc, o.topic!, t.trim()))
          : []
      const found = hits.filter((h): h is NonNullable<typeof h> => !!h)
      if (!found.length) {
        failed.push(`assign: no item ${o.item ?? o.tasks ?? ''}`)
        continue
      }
      for (const h of found) {
        h.item.agent = o.agent!.trim()
        if (!h.item.task) h.item.task = nextOrdinal(h.topic, h.item.agent)
      }
      done.push(`${found.map((h) => h.item.id).join(', ')} assigned to @${o.agent!.trim()}`)
      continue
    }

    if (o.op === 'learn') {
      const topic = ensureTopic(doc, o.topic!)
      const made = addItem(topic, { kind: 'learned', text: o.text!.trim() })
      done.push(`${made.id} learned`)
      continue
    }

    const hit = o.item ? findItem(doc, o.item) : o.topic && o.task ? findByTask(doc, o.topic, o.task) : undefined
    if (!hit) {
      failed.push(`${o.op}: no item ${o.item}`)
      continue
    }
    const { topic, item } = hit
    if (o.op === 'answer') {
      if (item.kind !== 'question') {
        failed.push(`answer ${item.id}: only an open question can be answered`)
        continue
      }
      if (!quoteIsVerbatim(o.quote!, ctx.userTexts)) {
        failed.push(`answer ${item.id}: the quote is not in any user message, so the question stays open.`)
        continue
      }
      // The answered question becomes a decision, with the question kept beside it.
      const asked = item.text
      item.kind = 'decided'
      item.text = o.text!.trim()
      item.quote = o.quote!.trim()
      item.detail = `Answers: ${asked}`
      delete item.owner
      delete item.done
      delete item.rec
      done.push(`${item.id} answered, now decided (quote verified)`)
      continue
    }
    if (o.op === 'close') {
      if (item.kind === 'question') {
        failed.push(`close ${item.id}: a question ends as a decision, even a dropped one. Use op answer with what was decided (for example "not doing this") and the user's words that settled it.`)
        continue
      }
      if (item.kind === 'todo' && item.owner === 'claude' && !o.evidence) {
        failed.push(`close ${item.id}: Claude's to-dos close with evidence (what ran and what it showed)`)
        continue
      }
      item.done = true
      if (o.evidence) item.detail = `Evidence: ${o.evidence.trim()}`
      else if (o.text) item.detail = o.text.trim()
      done.push(`${item.id} closed`)
    } else if (o.op === 'reopen') {
      item.done = false
      done.push(`${item.id} reopened`)
    } else if (o.op === 'remove') {
      topic.items = topic.items.filter((i) => i !== item)
      done.push(`${item.id} removed`)
    } else if (o.op === 'logged') {
      item.logged = true
      done.push(`${item.id} marked logged on the card`)
    } else if (o.op === 'edit') {
      if (o.text) item.text = o.text.trim()
      if (o.detail !== undefined) item.detail = o.detail.trim() || undefined
      if (o.rec !== undefined) item.rec = o.rec.trim() || undefined
      const who = owner(o.owner)
      if (who) item.owner = who
      done.push(`${item.id} edited`)
    }
  }

  const changed = done.length > 0
  if (changed) doc.updatedTurn = ctx.turn
  return { doc, done, failed, changed }
}

export const isOpenFor = (item: LedgerItem, who: LedgerOwner): boolean =>
  (item.kind === 'question' || item.kind === 'todo') && item.owner === who && !item.done

// Claude's open to-dos, oldest first, each with how many turns it has been open:
// what the tool reply and every prompt show so a finished step is closed at the
// step, not remembered later. Topics that are done or rejected are skipped.
export const openTodoLines = (
  doc: LedgerDoc,
  turn: number,
  who: LedgerOwner = 'claude',
  max = 8,
  finished: ReadonlySet<string> = new Set(),
): string[] => {
  const rows: { topic: LedgerTopic; item: LedgerItem; age: number }[] = []
  for (const t of doc.topics) {
    if (t.status === 'done' || t.status === 'rejected') continue
    for (const i of t.items) {
      if (i.kind !== 'todo' || !isOpenFor(i, who)) continue
      rows.push({ topic: t, item: i, age: i.turn === undefined ? Number.MAX_SAFE_INTEGER : Math.max(0, turn - i.turn) })
    }
  }
  rows.sort((a, b) => b.age - a.age)
  const topics = new Set(rows.map((r) => r.topic.id))
  const out = rows.slice(0, max).map((r) => {
    const where = topics.size > 1 ? ` [${r.topic.name}]` : ''
    const age = r.age === Number.MAX_SAFE_INTEGER ? 'open since before turn stamps' : r.age === 0 ? 'this turn' : `${r.age} turn${r.age === 1 ? '' : 's'} open`
    const agent = r.item.agent ? ` @${r.item.agent}${finished.has(r.item.agent) ? ' FINISHED, step still open' : ''}` : ''
    return `  - ${r.item.id} (${age})${where}${agent}: ${line(stepText(r.item), 120)}`
  })
  if (rows.length > max) out.push(`  … ${rows.length - max} more`)
  return out
}

// A decision counts as logged when marked so, or when the card's log carries its quote.
export const isLogged = (item: LedgerItem, card: LedgerCard | undefined): boolean => {
  if (item.logged) return true
  if (!card || !item.quote) return false
  const frag = quoteFragments(item.quote)[0]?.slice(0, 60)
  if (!frag) return false
  return card.logTexts.some((t) => norm(t).includes(frag))
}

export const gapsFor = (doc: LedgerDoc, board: LedgerBoard | null): Gap[] => {
  const gaps: Gap[] = []
  // Build steps are judged per card, not per topic: a card is covered when ANY
  // topic linked to it holds an open Claude to-do, so a finished plan-review
  // topic still linked to a building card never reports the gap on its own.
  const cardsWithBuildSteps = new Set(
    doc.topics
      .filter((t) => t.card && t.items.some((i) => i.kind === 'todo' && i.owner === 'claude' && !i.done))
      .map((t) => t.card as string),
  )
  const buildGapReported = new Set<string>()
  for (const t of doc.topics) {
    if (t.exempt || t.status === 'rejected') continue
    const decided = t.items.filter((i) => i.kind === 'decided')
    // No board beside this project (someone else's machine, or not read yet): nothing to keep in sync.
    if (!board?.found) continue
    if (!t.card) {
      if (t.status === 'hold') gaps.push({ topicId: t.id, text: 'On hold: needs a board card with a trigger' })
      else if (decided.length) gaps.push({ topicId: t.id, text: 'Decisions here have no board card' })
      continue
    }
    const card = board.cards[t.card]
    if (!card) {
      gaps.push({ topicId: t.id, text: `Card ${t.card} is not on the board` })
      continue
    }
    for (const d of decided) {
      if (!isLogged(d, card)) gaps.push({ topicId: t.id, itemId: d.id, text: `Decision not logged on ${card.id}: ${d.text}` })
    }
    if (card.status === 'building' && !cardsWithBuildSteps.has(card.id) && !buildGapReported.has(card.id)) {
      buildGapReported.add(card.id)
      gaps.push({ topicId: t.id, text: `${card.id} is building but has no open build steps here: add them as Claude to-dos and tick them off as they land` })
    }
    if (t.status === 'hold' && card.status === 'backlog' && !card.trigger) {
      gaps.push({ topicId: t.id, text: `On hold: ${card.id} has no trigger` })
    }
  }
  return gaps
}

// Every card object on the board, wherever the tree holds it.
export const parseBoardCards = (html: string): Record<string, LedgerCard> => {
  const m = html.match(/<script type="application\/json" id="board-data">([\s\S]*?)<\/script>/)
  if (!m || !m[1]) throw new Error('board-data block not found')
  const data = JSON.parse(m[1]) as { root?: unknown }
  const out: Record<string, LedgerCard> = {}
  const walk = (n: unknown): void => {
    if (!n || typeof n !== 'object') return
    if (Array.isArray(n)) {
      for (const x of n) walk(x)
      return
    }
    const o = n as Record<string, unknown>
    if (typeof o.id === 'string' && typeof o.title === 'string' && typeof o.status === 'string') {
      const log = Array.isArray(o.log) ? (o.log as { text?: string }[]) : []
      const texts = log.map((l) => (typeof l?.text === 'string' ? l.text : '')).filter(Boolean)
      out[o.id] = {
        id: o.id,
        title: o.title,
        status: o.status,
        campaign: typeof o.campaign === 'string' ? o.campaign : undefined,
        awaiting: typeof o.awaiting === 'string' ? o.awaiting : undefined,
        nextAction: typeof o.nextAction === 'string' ? o.nextAction : undefined,
        trigger: typeof o.trigger === 'string' ? o.trigger : undefined,
        lastLog: texts[texts.length - 1],
        logTexts: texts.slice(-40),
        logCount: texts.length,
        decision: o.decision === true,
      }
    }
    for (const [k, v] of Object.entries(o)) if (k !== 'log' && typeof v === 'object') walk(v)
  }
  walk(data.root ?? data)
  return out
}

// The linked cards, plus every card waiting on a ruling in a campaign a linked card belongs to.
export const boardView = (
  all: Record<string, LedgerCard>,
  doc: LedgerDoc,
): { cards: Record<string, LedgerCard>; rulings: LedgerRuling[] } => {
  const cards: Record<string, LedgerCard> = {}
  const campaigns = new Set<string>()
  for (const t of doc.topics) {
    const c = t.card ? all[t.card] : undefined
    if (c) {
      cards[c.id] = c
      if (c.campaign) campaigns.add(c.campaign)
    }
  }
  const rulings = Object.values(all)
    .filter((c) => c.decision && c.status !== 'done' && c.campaign && campaigns.has(c.campaign))
    .map((c) => ({ id: c.id, title: c.title, campaign: c.campaign, nextAction: c.nextAction }))
  return { cards, rulings }
}

// What changed on a linked card between two reads of the board.
export const cardChanges = (before: LedgerCard | undefined, after: LedgerCard): string[] => {
  if (!before) return []
  const out: string[] = []
  if (before.status !== after.status) out.push(`moved to ${after.status}`)
  if (after.logCount > before.logCount) {
    const tag = (after.lastLog ?? '').split(':')[0]?.slice(0, 24) || 'an entry'
    out.push(`logged ${tag}:`)
  }
  return out
}

const line = (s: string, max = 160): string => (s.length > max ? `${s.slice(0, max - 1)}…` : s)

// What the model reads: the whole ledger, compact.
export const digest = (doc: LedgerDoc, board: LedgerBoard | null, gaps: Gap[]): string => {
  const out: string[] = ['Session ledger (the ledger mod; update it with the ledger tool).']
  if (doc.hold) out.push(`HOLD: ${doc.hold}`)
  for (const t of doc.topics) {
    const card = t.card ? ` card ${t.card}${board?.cards[t.card] ? ` (${board.cards[t.card]!.status})` : ''}` : t.exempt ? ' exempt' : ''
    out.push(`## ${t.name} [${t.status}]${card}`)
    for (const i of t.items) {
      if (i.kind === 'decided') out.push(`  ${i.id} decided: ${line(i.text)}`)
      else if (i.kind === 'learned') out.push(`  ${i.id} learned: ${line(i.text)}`)
      else if (!i.done) out.push(`  ${i.id} ${i.kind === 'question' ? 'open question' : 'to-do'} (${i.agent ? `@${i.agent}` : i.owner}): ${line(stepText(i))}`)
    }
  }
  const tail = boardDigest(board, gaps)
  if (tail) out.push(tail)
  return out.join('\n')
}

// The board part alone, sent each turn while anything in it is open.
export const boardDigest = (board: LedgerBoard | null, gaps: Gap[]): string => {
  const out: string[] = []
  if (gaps.length) out.push('Board gaps (close them in the work):', ...gaps.map((g) => `  - ${g.text}`))
  if (board?.rulings.length)
    out.push('Board rulings waiting on the user:', ...board.rulings.map((r) => `  - ${r.id}: ${line(r.nextAction ?? r.title, 120)}`))
  const others = board?.changes.filter((c) => c.by === 'other') ?? []
  if (others.length) out.push('Changed by another session:', ...others.slice(-5).map((c) => `  - ${c.card} ${c.text}`))
  return out.join('\n')
}

// Cards named by board-tool calls not seen before (marked seen now). A failed or unanswered call changed nothing.
export const newBoardToolCards = (
  uses: { tool_use_id: string; tool: string; input: Record<string, unknown>; text?: string; isError?: true }[],
  seen: Set<string>,
): Set<string> => {
  const ids = new Set<string>()
  for (const u of uses) {
    if (u.tool !== 'mcp__board__board' || u.isError || u.text === undefined || seen.has(u.tool_use_id)) continue
    seen.add(u.tool_use_id)
    const ops = Array.isArray(u.input.ops) ? (u.input.ops as { id?: unknown }[]) : []
    for (const op of ops) if (typeof op?.id === 'string') ids.add(op.id)
  }
  return ids
}

// The person's saved messages: newest kept, each capped, a repeat of the last one skipped.
export const addSaid = (said: string[], text: string, max = 300, cap = 6000): string[] => {
  const t = text.trim().slice(0, cap)
  if (!t || said.at(-1) === t) return said
  return [...said, t].slice(-max)
}
