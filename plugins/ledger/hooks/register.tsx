import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { LedgerBoard, LedgerCard, LedgerDoc, LedgerFilter, LedgerItem, LedgerTopic } from '../types'
import {
  applyOps,
  boardDigest,
  boardView,
  cardChanges,
  cleanName,
  digest,
  emptyDoc,
  gapsFor,
  isLogged,
  addSaid,
  isOpenFor,
  openTodoLines,
  agentBrief,
  stepText,
  compareTasks,
  newBoardToolCards,
  parseBoardCards,
} from './model'
import type { Gap, LedgerOp } from './model'

const PANE = 'ledger'
const TOOL = 'mcp__ledger__ledger'
const BOARD_TOOL = 'mcp__board__board'

const ACC = '#e0905f'
const OK = '#7ee0a1'
const TEAL = '#5fd4c4'
const BLUE = '#79b8ff'
const VIO = '#c3a6ff'
const AMB = '#e8c06a'
const GREY = '#8b929c'
const INK = '#14161a'

const docA = atom({ plugin: 'ledger', key: 'doc' } as const, emptyDoc())
const boardA = atom({ plugin: 'ledger', key: 'board' } as const, null)
const openA = atom({ plugin: 'ledger', key: 'open' } as const, {})
const filterA = atom({ plugin: 'ledger', key: 'filter' } as const, 'all')
const turnsA = atom({ plugin: 'ledger', key: 'turns' } as const, 0)
// Names of dispatched agents that have finished (completed, failed or killed): a step still
// open under such a name is flagged wherever steps are listed.
const finishedA = atom({ plugin: 'ledger', key: 'finished' } as const, [] as string[])

// Agent types that only read: no steps required to dispatch them.
const READ_ONLY_AGENTS = new Set(['Explore', 'Plan', 'claude-code-guide', 'test-context-researcher', 'statusline-setup'])

const DESCRIPTION = [
  "The session ledger: the running record of this conversation, shown in the user's Ledger pane and attached to the conversation when it matters.",
  'Update it (several ops in one call) as things happen, not at the end:',
  '- a topic opens or its status changes: op topic (status now|exploring|shaped|chosen|hold|rejected|review|done; only one topic is "now").',
  "- the user rules on something: op decide, with quote = the user's exact words copied from their message (use ... to skip words). It is rejected unless the quote is in a user message. Never record your own recommendation as decided.",
  "- you ask the user something, or recommend something they have not confirmed: op ask, owner you, rec = your recommended answer written as the user would say it ('Yes, build it next.'), detail = why.",
  "- the user answers a question: op answer, item = its id, text = the decision, quote = the user's exact words. It moves to Decided. A question that stops mattering is answered too, never closed: text says what was decided (for example \"not doing this\"), quote = the user's words that settled it. Dropping a question is a decision.",
  '- either of you commits to doing something: op todo, owner you|claude.',
  '- you start building something: before writing code, add each major step of the build as a to-do (owner claude), in the order you will do it, worded as the action in plain words so the user can tell what is happening: "Build the panel the side chat lives in", "Build the file and board lookups", "Write the tests for asking a question", "Run the tests", "Install it for every session". Not a feature label like "Lookups, read-only". Close each with evidence the moment it is done; add new steps the same way as they come up.',
  '- you dispatch an agent to do work: first give it steps. For an OpenSpec change: op tasks (topic, change=<change name>, agent=<agent name>, tasks="3.1,3.2" to pick some) loads the unticked tasks of openspec/changes/<change>/tasks.md as numbered to-dos. For any other work: op todo with agent=<agent name> per step, in order; the tool numbers them 1, 2, 3. Dispatching a working agent by name with no open steps under that name is refused; when steps exist, the agent\'s prompt and every follow-up message to it carry its step ids and the close instruction automatically. Reassign with op assign (agent, and item or topic+tasks).',
  '- a fact changes the options: op learn.',
  "- something is finished: op close with item id (or topic + task number); Claude's to-dos need evidence (what ran and what it showed). A step whose agent has finished while it is still open is flagged FINISHED; close it with evidence you verified or reopen it as work still owed.",
  'Link a topic to its board card with op topic card=<card-id>, or set exempt=true when the board rules exempt the work (Claude meta-tooling). The ledger only reads the board: you write it with the board tool, logging each decision with the user\'s exact words in quotes; the ledger sees the quote on the card and marks it logged by itself. Use op logged item=<id> only when the card log cannot carry the quote.',
  'Other ops: edit (item, text, detail, owner), reopen, remove, hold (text, or empty to clear), title (text). An empty ops list returns the current ledger.',
].join('\n')

const SCHEMA = {
  type: 'object',
  properties: {
    ops: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          op: {
            type: 'string',
            enum: ['topic', 'decide', 'ask', 'answer', 'todo', 'learn', 'close', 'reopen', 'edit', 'remove', 'logged', 'hold', 'title', 'tasks', 'assign'],
          },
          agent: { type: 'string', description: 'todo, tasks, assign: the name of the agent responsible for the step(s).' },
          task: { type: 'string', description: 'A step number such as 3.4; with topic, names an item instead of its id.' },
          change: { type: 'string', description: 'tasks: the OpenSpec change whose tasks.md is loaded.' },
          tasks: { type: 'string', description: 'tasks, assign: comma-separated step numbers to load or reassign.' },
          topic: { type: 'string', description: 'Topic name or id; a new name opens the topic.' },
          text: { type: 'string' },
          quote: { type: 'string', description: "decide: the user's exact words." },
          owner: { type: 'string', enum: ['you', 'claude'], description: 'you = the user.' },
          detail: { type: 'string', description: 'ask: why you recommend it. todo: what it involves.' },
          rec: { type: 'string', description: "ask: your recommended answer, in the user's voice." },
          item: { type: 'string', description: 'An item id such as ledger.3.' },
          status: { type: 'string' },
          card: { type: 'string', description: 'Board card id; empty string unlinks.' },
          exempt: { type: 'boolean' },
          evidence: { type: 'string' },
        },
        required: ['op'],
      },
    },
  },
  required: ['ops'],
}

type Env = EngineInterface

let sessionId = ''
let boardPath = ''
let allCards: Record<string, LedgerCard> = {}
let lastMtime = 0
let ownMtime = -1
let needFull = false
let lastExtras = ''
const seenBoardUses = new Set<string>()

async function save($: Env, doc: LedgerDoc) {
  if (!sessionId) return
  await $.store.set(`doc:${sessionId}`, doc)
  const ids = ((await $.store.get('sessions')) as string[] | undefined) ?? []
  const next = [...ids.filter((i) => i !== sessionId), sessionId]
  for (const old of next.slice(0, Math.max(0, next.length - 40))) {
    await $.store.delete(`doc:${old}`)
    await $.store.delete(`said:${old}`)
  }
  await $.store.set('sessions', next.slice(-40))
}

async function findBoard($: Env): Promise<string> {
  let dir = (await $.session.root()).replace(/\\/g, '/')
  for (let i = 0; i < 5; i += 1) {
    const p = `${dir}/../Telify-board/docs/board/index.html`
    if (await $.fs.exists(p)) return (await $.fs.stat(p, { resolve: true })).realPath ?? p
    dir = `${dir}/..`
  }
  return ''
}

function sameFile(a: string, b: string) {
  return a.replace(/\\/g, '/').toLowerCase() === b.replace(/\\/g, '/').toLowerCase()
}

// Re-derive what the pane shows from the cached board, for a doc that just changed.
async function refreshView($: Env) {
  const prev = await read($, boardA)
  if (!prev?.found) return
  // Just reloaded: the parsed cards are gone until the board is read again.
  if (!Object.keys(allCards).length) return refreshBoard($, true)
  const doc = await read($, docA)
  const view = boardView(allCards, doc)
  await update($, boardA, () => ({ ...prev, cards: view.cards, rulings: view.rulings }))
}

// The tasks.md of an OpenSpec change under the session root; undefined when there is none.
async function readTasks($: Env, change: string): Promise<string | undefined> {
  const root = (await $.session.root()).replace(/\\/g, '/')
  const p = `${root}/openspec/changes/${change.trim()}/tasks.md`
  if (!(await $.fs.exists(p))) return undefined
  return (await $.fs.read(p)) as string
}

// Names of dispatched agents no longer running, for the FINISHED flag on their open steps.
async function refreshAgents($: Env) {
  const agents = await $.agent.list()
  const finished = agents.filter((a) => a.name && a.status !== 'running').map((a) => a.name as string)
  const prev = await read($, finishedA)
  if (prev.length === finished.length && prev.every((n, i) => n === finished[i])) return
  await update($, finishedA, () => finished)
}

async function refreshBoard($: Env, force = false) {
  if (!boardPath) {
    await update($, boardA, () => ({ found: false, path: '', cards: {}, rulings: [], changes: [] }))
    return
  }
  const st = await $.fs.stat(boardPath)
  if (!force && st.mtimeMs === lastMtime) return
  const own = await ownBoardCards($)
  const html = (await $.fs.read(boardPath)) as string
  allCards = parseBoardCards(html)
  const doc = await read($, docA)
  const view = boardView(allCards, doc)
  const prev = await read($, boardA)
  const now = await $.clock.now()
  const changes = [...(prev?.changes ?? [])]
  if (prev?.found && lastMtime) {
    for (const card of Object.values(view.cards)) {
      const by: 'claude' | 'other' = st.mtimeMs === ownMtime || own.has(card.id) ? 'claude' : 'other'
      for (const text of cardChanges(prev.cards[card.id], card)) changes.push({ card: card.id, text, by, at: now })
    }
  }
  lastMtime = st.mtimeMs
  const board: LedgerBoard = { found: true, path: boardPath, cards: view.cards, rulings: view.rulings, changes: changes.slice(-20) }
  await update($, boardA, () => board)
}

// Cards this session changed through the board tool since the last look. The board mod answers
// that tool itself, so the ledger never sits in its call; the session's own tool list says it ran.
async function ownBoardCards($: Env): Promise<Set<string>> {
  return newBoardToolCards((await $.session.messages()).flatMap((m) => m.toolUses), seenBoardUses)
}

// The user's words: their messages, and what they picked or typed in a question box.
// Every message the person sends, saved as it is sent: one sent mid-turn is stored as a queued note,
// never as a user message, so the transcript alone would miss it.
async function ensureSession($: Env) {
  if (!sessionId) sessionId = await $.session.id().catch(() => '')
  return sessionId
}

async function rememberSaid($: Env, text: string) {
  if (!(await ensureSession($))) return
  const said = ((await $.store.get(`said:${sessionId}`)) as string[] | undefined) ?? []
  const next = addSaid(said, text)
  if (next !== said) await $.store.set(`said:${sessionId}`, next)
}

async function userTexts($: Env) {
  const said = (await ensureSession($)) ? (((await $.store.get(`said:${sessionId}`)) as string[] | undefined) ?? []) : []
  const messages = await $.session.messages()
  const typed = messages.filter((m) => m.role === 'user').map((m) => m.text)
  const picked = messages
    .flatMap((m) => m.toolUses)
    .filter((u) => u.tool === 'AskUserQuestion' && !u.isError && typeof u.text === 'string')
    .map((u) => u.text as string)
  return [...typed, ...picked, ...said]
}

// Your own to-do, checked off or back on from the panel; Claude's close only through the tool, with evidence.
async function checkTodo($: Env, item: string, done: boolean) {
  const doc = await read($, docA)
  const r = applyOps(doc, [{ op: done ? 'close' : 'reopen', item }], { userTexts: [], turn: await $.session.turns() })
  if (r.changed) await commit($, r.doc)
}

async function commit($: Env, doc: LedgerDoc) {
  await update($, docA, () => doc)
  await save($, doc)
  await refreshView($)
}

// Board edits Claude makes: the next board read attributes them to Claude, not another session.
async function markOwnBoardWrite($: Env, path: string | undefined, before: number) {
  if (!boardPath || !path) return
  const real = (await $.fs.stat(path, { resolve: true }).catch(() => undefined))?.realPath ?? path
  if (!sameFile(real, boardPath)) return
  const st = await $.fs.stat(boardPath)
  if (st.mtimeMs !== before) {
    ownMtime = st.mtimeMs
    await refreshBoard($)
  }
}

// Puts an answer in the prompt box, after anything already typed there.
async function fillPrompt($: Env, text: string) {
  const box = await $.prompt.read()
  const draft = box.text.trimEnd()
  await $.prompt.fill({ text: draft ? `${draft}\n${text}` : text })
}

export const register: Register = (on) => {
  on('session.start', async ($, e, next) => {
    sessionId = await $.session.id()
    const stored = (await $.store.get(`doc:${sessionId}`)) as LedgerDoc | undefined
    const held = await read($, docA)
    const doc = held.topics.length ? held : stored ?? emptyDoc()
    await update($, docA, () => doc)
    await update($, turnsA, () => 0)
    // A hot reload keeps the state, so only a fresh start or a resume re-sends the whole ledger.
    needFull = !held.topics.length && doc.topics.length > 0
    await $.tool.register({ name: 'ledger', description: DESCRIPTION, inputSchema: SCHEMA })
    await $.command.register({
      name: 'ledger',
      description: 'Open the session ledger (close · catch-up)',
      argumentHint: '[close|catch-up]',
    })
    boardPath = await findBoard($)
    await refreshBoard($, true)
    $.clock.every(20000, () => {
      void refreshBoard($)
      void refreshAgents($)
    })
    return next(e)
  })

  // The dispatch door: the Agent tool call itself (the engine's agent.spawn event did not reach a
  // hook of this plugin in the live session on 2026-10-03). A working agent dispatched by name
  // needs open steps under that name; with them, its prompt ends with the brief (ids, the tool,
  // close as you go).
  on('tool.call', { tool: 'Agent' }, async ($, e, next) => {
    const input = e as unknown as { prompt?: unknown; name?: unknown; subagent_type?: unknown }
    const type = typeof input.subagent_type === 'string' ? input.subagent_type : 'general-purpose'
    if (READ_ONLY_AGENTS.has(type) || typeof input.prompt !== 'string') return next(e)
    const name = typeof input.name === 'string' ? input.name.trim() : ''
    const doc = await read($, docA)
    const brief = name ? agentBrief(doc, name) : null
    if (!brief) {
      return {
        deny: name
          ? `Ledger: no open steps are assigned to @${name}. Before dispatching, add its steps with the ledger tool (op tasks with change+agent, or op todo with agent per step), then dispatch again.`
          : 'Ledger: a working agent needs a name and steps. Dispatch it with name=<agent> after adding its steps with the ledger tool (op tasks or op todo with agent).',
      }
    }
    return next({ ...e, prompt: `${input.prompt}\n\n${brief}` } as typeof e)
  })

  // A follow-up message to a named agent carries whatever it still has open.
  on('tool.call', { tool: 'SendMessage' }, async ($, e, next) => {
    const input = e as unknown as { to?: unknown; message?: unknown }
    if (typeof input.to !== 'string' || typeof input.message !== 'string') return next(e)
    const brief = agentBrief(await read($, docA), input.to.trim())
    if (!brief) return next(e)
    return next({ ...e, message: `${input.message}\n\n${brief}` } as typeof e)
  })

  on('tool.call', { tool: TOOL }, async ($, e) => {
    const ops = (Array.isArray(e.ops) ? e.ops : []) as LedgerOp[]
    const doc = await read($, docA)
    const board = await read($, boardA)
    if (!ops.length) return { result: doc.topics.length ? digest(doc, board, gapsFor(doc, board)) : 'The ledger is empty.' }
    const turn = await $.session.turns()
    const withContent = await Promise.all(ops.map(async (o) => (o.op === 'tasks' && o.change ? { ...o, content: await readTasks($, o.change) } : o)))
    const r = applyOps(doc, withContent, { userTexts: await userTexts($), turn })
    if (r.changed) await commit($, r.doc)
    const gaps = gapsFor(r.doc, await read($, boardA))
    const lines = [...r.done.map((d) => `ok: ${d}`), ...r.failed.map((f) => `FAILED: ${f}`)]
    if (gaps.length) lines.push('Board gaps now:', ...gaps.map((g) => `  - ${g.text}`))
    const open = openTodoLines(r.doc, turn, 'claude', 8, new Set(await read($, finishedA)))
    if (open.length) lines.push('Open to-dos (claude), close each the moment its evidence exists:', ...open)
    if (!r.done.length) return { deny: lines.join('\n') }
    return { result: lines.join('\n') }
  })

  on('tool.call', async ($, e, next) => {
    const tool = String(e.tool)
    const isEdit = tool === 'Edit' || tool === 'Write' || tool === 'MultiEdit'
    const isBash = tool === 'Bash' || tool === 'PowerShell'
    const input = e as unknown as { file_path?: string; command?: string }
    const touchesBoard = tool === BOARD_TOOL || (isBash && typeof input.command === 'string' && input.command.includes('Telify-board'))
    if (!boardPath || (!isEdit && !touchesBoard)) return next(e)
    const before = (await $.fs.stat(boardPath)).mtimeMs
    const ran = await next(e)
    await markOwnBoardWrite($, isEdit ? input.file_path : boardPath, before)
    return ran
  })

  on('prompt.submit', async ($, e, next) => {
    await rememberSaid($, e.text)
    const doc = await read($, docA)
    const board = await read($, boardA)
    const context: string[] = []
    if (doc.topics.length || doc.hold) {
      const gaps = gapsFor(doc, board)
      if (needFull) {
        context.push(digest(doc, board, gaps))
        needFull = false
        lastExtras = boardDigest(board, [])
      } else {
        const extras = boardDigest(board, [])
        const parts: string[] = []
        if (gaps.length) parts.push(boardDigest(null, gaps))
        if (extras && extras !== lastExtras) parts.push(extras)
        lastExtras = extras
        if (parts.length) context.push(`Session ledger, board state:\n${parts.join('\n')}`)
        const open = openTodoLines(doc, await $.session.turns(), 'claude', 8, new Set(await read($, finishedA)))
        if (open.length)
          context.push(`Session ledger, open to-dos (claude). Close each with evidence the moment it is done, before replying:\n${open.join('\n')}`)
      }
    }
    const ran = await next(context.length ? { ...e, context: [...(e.context ?? []), ...context] } : e)
    const turns = await $.session.turns()
    await update($, turnsA, () => turns)
    return ran
  })

  on('session.compact', async ($, e, next) => {
    const ran = await next(e)
    needFull = true
    return ran
  })

  on('turn.complete', async ($, e, next) => {
    const ran = await next(e)
    if (e.agentId === undefined) {
      const turns = await $.session.turns()
      await update($, turnsA, () => turns)
    }
    return ran
  })

  on('command.run', { command: 'ledger' }, async ($, e) => {
    const arg = e.args.trim()
    if (arg === 'close') {
      await $.ui.close({ id: PANE })
      return {}
    }
    if (arg === 'catch-up') {
      const doc = await read($, docA)
      const prompt = [
        'Update the session ledger kept beside this conversation. The ledger now, as JSON:',
        JSON.stringify(doc),
        '',
        'Return ONLY a JSON array of ops, no prose, for what this conversation holds that the ledger is missing or has wrong. Op shapes:',
        '{"op":"topic","topic":"<name>","status":"now|exploring|shaped|chosen|hold|rejected|review|done","card":"<board card id>","exempt":true}',
        '{"op":"decide","topic":"<name>","text":"<the decision>","quote":"<the user\'s exact words, copied verbatim>"}',
        '{"op":"ask","topic":"<name>","text":"<question>","owner":"you|claude","rec":"<recommended answer>","detail":"<why>"}',
        '{"op":"answer","item":"<question id>","text":"<the decision>","quote":"<the user\'s exact words>"}',
        '{"op":"todo","topic":"<name>","text":"<task>","owner":"you|claude"}',
        '{"op":"learn","topic":"<name>","text":"<fact>"}',
        '{"op":"close","item":"<item id>","evidence":"<what ran and what it showed>"}',
        'A recommendation the user has not confirmed is an ask, never a decide. Return [] when nothing is missing.',
      ].join('\n')
      const reply = await $.model.fork({ prompt })
      if (!reply.isAnswered) return { text: `Ledger catch-up failed: ${reply.reason}` }
      const start = reply.text.indexOf('[')
      const end = reply.text.lastIndexOf(']')
      let ops: LedgerOp[] = []
      try {
        ops = JSON.parse(reply.text.slice(start, end + 1)) as LedgerOp[]
      } catch {
        return { text: 'Ledger catch-up: the reply was not a list of ops; nothing changed.' }
      }
      const r = applyOps(doc, ops, { userTexts: await userTexts($), turn: await $.session.turns() })
      if (r.changed) {
        await commit($, r.doc)
        needFull = true
      }
      return {
        text: `Ledger catch-up: ${r.done.length} recorded, ${r.failed.length} rejected.${r.failed.length ? `\n${r.failed.join('\n')}` : ''}`,
      }
    }
    await $.ui.open({ id: PANE, title: 'Ledger' })
    return {}
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const doc = await read($, docA)
    if (!doc.topics.length && !doc.hold) return next(e)
    const board = await read($, boardA)
    const turns = await read($, turnsA)
    const view = buildView(doc, board, {}, 'all')
    const { Box, Text, Button } = $.ui.resolve(e)
    const ago = turns - doc.updatedTurn
    return (
      <Box flexDirection="row" width={e.props.bodyColumns}>
        <Text color={ACC} bold>
          {'▎ledger  '}
        </Text>
        <Text color={ACC}>{`${view.you} for you`}</Text>
        <Text dimColor>{' · '}</Text>
        <Text color={GREY}>{`${view.claude} on Claude`}</Text>
        <Text dimColor>{' · '}</Text>
        <Text color={view.gaps ? AMB : GREY}>{view.gaps ? `${view.gaps} board gap${view.gaps > 1 ? 's' : ''}` : 'board in sync'}</Text>
        <Text dimColor>{ago <= 0 ? ' · updated this turn' : ` · updated ${ago} turn${ago > 1 ? 's' : ''} ago`}</Text>
        <Box flexGrow={1} />
        <Button key="open-ledger" plain label="open ledger" hotkey="l" onPress={() => void $.ui.open({ id: PANE, title: 'Ledger' })} />
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const doc = await read($, docA)
    const board = await read($, boardA)
    const open = await read($, openA)
    const filter = await read($, filterA)
    const turns = await read($, turnsA)
    // Two cells of margin on the right, so nothing runs into the frame.
    const W = Math.max(30, e.props.bodyColumns - 2)
    const view = buildView(doc, board, open, filter, new Set(await read($, finishedA)))
    const legend = legendFor(doc)
    const { Box, Text, Button } = $.ui.resolve(e)
    const toggle = (key: string, isOpen: boolean) => () => void update($, openA, (o) => ({ ...o, [key]: !isOpen }))

    const filters: { id: LedgerFilter; label: string }[] = [
      { id: 'all', label: 'All topics' },
      { id: 'you', label: `For you ${view.you}` },
      { id: 'claude', label: `Claude ${view.claude}` },
      { id: 'board', label: view.gaps ? `Board ${view.gaps} gap${view.gaps > 1 ? 's' : ''}` : 'Board ✓' },
    ]

    return (
      <Box flexDirection="column" width={W}>
        <Box flexDirection="row">
          <Text color={ACC} bold>
            {'LEDGER  '}
          </Text>
          <Text bold wrap="truncate-end">
            {doc.title || 'This session'}
          </Text>
          <Box flexGrow={1} />
          <Text dimColor>{`this conversation · ${turns} turn${turns === 1 ? '' : 's'}`}</Text>
          <Text>{'    '}</Text>
        </Box>
        <Text dimColor>{'─'.repeat(W)}</Text>
        <Box flexDirection="row" gap={1}>
          {filters.map((f, i) =>
            f.id === filter ? (
              <Button key={`f-${f.id}`} variant="primary" label={f.label} hotkey={String(i + 1)} onPress={() => void update($, filterA, () => f.id)} />
            ) : (
              <Button key={`f-${f.id}`} plain dimColor label={f.label} hotkey={String(i + 1)} onPress={() => void update($, filterA, () => f.id)} />
            ),
          )}
        </Box>
        {doc.hold ? (
          <Box flexDirection="row" marginTop={1}>
            <Text backgroundColor={VIO} color={INK} bold>
              {' HOLD '}
            </Text>
            <Text color={GREY}>{` ${doc.hold}`}</Text>
          </Box>
        ) : null}
        {view.topics.length === 0 ? (
          <Box marginTop={1}>
            <Text dimColor>
              {filter === 'all'
                ? 'Nothing recorded yet. Topics, decisions and to-dos land here as they come up.'
                : 'Nothing here right now.'}
            </Text>
          </Box>
        ) : null}
        {view.topics.map((t) => (
          <Box key={`tb-${t.id}`} flexDirection="column" marginTop={1}>
            <Box flexDirection="row">
              <Text dimColor>{t.isOpen ? '▾ ' : '▸ '}</Text>
              <Text color={t.glyphColor}>{`${t.glyph} `}</Text>
              <Button key={`t-${t.id}`} plain label={t.isOpen ? split(t.name, W - 22)[0] : clip(t.name, W - 22)} onPress={toggle(`t:${t.id}`, t.isOpen)} />
              <Box flexGrow={1} />
              {t.chip ? (
                <Text backgroundColor={t.chipColor} color={INK} bold>
                  {` ${t.chip} `}
                </Text>
              ) : (
                <Text dimColor>{t.chipText}</Text>
              )}
            </Box>
            {t.isOpen && split(t.name, W - 22)[1] ? (
              <Box paddingLeft={4}>
                <Text>{split(t.name, W - 22)[1]}</Text>
              </Box>
            ) : null}
            <Box flexDirection="row" paddingLeft={4}>
              <Text color={GREY} wrap={t.isOpen ? 'wrap' : 'truncate-end'}>
                {t.sub}
              </Text>
              <Box flexGrow={1} />
              <Text color={t.countColor}>{` ${t.counts}`}</Text>
            </Box>
            {t.isOpen ? (
              <Box flexDirection="column" marginLeft={3}>
                {t.sections.map((s) => (
                  <Box key={`s-${t.id}-${s.label}`} flexDirection="column" marginTop={1}>
                    <Box flexDirection="row">
                      <Text dimColor>{s.isOpen ? '▾ ' : '▸ '}</Text>
                      <Button key={`sh-${t.id}-${s.label}`} plain dimColor label={`${s.label} ${s.rows.length}`} onPress={toggle(`s:${t.id}:${s.label}`, s.isOpen)} />
                    </Box>
                    {(s.isOpen ? s.rows : []).map((r) => {
                      const isOpen = open[`i:${r.key}`] === true
                      if (r.header) {
                        return (
                          <Box key={`r-${r.key}`} flexDirection="row" marginTop={1}>
                            <Text color={r.headerColor ?? GREY} wrap="truncate-end">{r.text}</Text>
                          </Box>
                        )
                      }
                      // The tag's column is reserved first, so a long title is clipped and the tag never wraps.
                      const tagW = r.tag === 'YOU' ? 6 : r.tag === 'CLAUDE' ? 9 : r.tag ? r.tag.length + 1 : 0
                      const titleW = Math.max(12, W - 18 - tagW)
                      return (
                        <Box key={`r-${r.key}`} flexDirection="column">
                          <Box flexDirection="row">
                            {r.check ? (
                              <Button key={`chk-${r.key}`} plain label={`${r.glyph} `} onPress={() => void checkTodo($, r.check!.item, !r.check!.done)} />
                            ) : (
                              <Text color={r.glyphColor}>{`${r.glyph} `}</Text>
                            )}
                            <Button key={`i-${r.key}`} plain dimColor={r.muted} label={isOpen ? split(r.text, titleW)[0] : clip(r.text, titleW)} onPress={toggle(`i:${r.key}`, isOpen)} />
                            <Box flexGrow={1} />
                            {r.tag === 'YOU' ? (
                              <Text backgroundColor={ACC} color={INK} bold>
                                {' YOU '}
                              </Text>
                            ) : r.tag === 'CLAUDE' ? (
                              <Text backgroundColor="#3a3f4a" color="#e6e8ec" bold>
                                {' CLAUDE '}
                              </Text>
                            ) : (
                              <Text color={r.tagColor}>{r.tag}</Text>
                            )}
                          </Box>
                          {isOpen && split(r.text, titleW)[1] ? (
                            <Box paddingLeft={2}>
                              <Text dimColor={r.muted}>{split(r.text, titleW)[1]}</Text>
                            </Box>
                          ) : null}
                          {isOpen ? (
                            <Box flexDirection="column" paddingLeft={2} marginBottom={1}>
                              {r.details.map((d, i) => (
                                <Box key={`d-${r.key}-${i}`}>
                                  <Text italic={d.italic} color={d.color ?? GREY}>
                                    {d.t}
                                  </Text>
                                </Box>
                              ))}
                              {r.fill ? (
                                <Box flexDirection="row" gap={2} marginTop={1}>
                                  {r.fill.rec ? (
                                    <Button
                                      key={`rec-${r.key}`}
                                      variant="primary"
                                      label="Use recommended"
                                      onPress={() => void fillPrompt($, `${cleanName(r.fill!.topic)}: ${r.fill!.question} ${r.fill!.rec}`)}
                                    />
                                  ) : null}
                                  <Button
                                    key={`own-${r.key}`}
                                    label="Different answer"
                                    onPress={() => void fillPrompt($, `${cleanName(r.fill!.topic)}: ${r.fill!.question} `)}
                                  />
                                </Box>
                              ) : null}
                            </Box>
                          ) : null}
                        </Box>
                      )
                    })}
                  </Box>
                ))}
              </Box>
            ) : null}
          </Box>
        ))}
        <Box flexDirection="column" marginTop={1}>
          <Text dimColor>{'─'.repeat(W)}</Text>
          {legend.map((row) => (
            <Box key={`lg-${row.name}`} flexDirection="row" flexWrap="wrap" columnGap={2}>
              <Text dimColor>{row.name}</Text>
              {row.keys.map((k) => (
                <Box key={`lg-${row.name}-${k.label}`} flexDirection="row">
                  <Text color={k.color}>{`${k.glyph} `}</Text>
                  <Text color={GREY}>{k.label}</Text>
                </Box>
              ))}
            </Box>
          ))}
          <Text dimColor>{'press a line to open it · 1-4 filters · esc back to prompt'}</Text>
        </Box>
      </Box>
    )
  })
}

// ---- view model: what the pane and the band draw ----

type Detail = { t: string; italic?: boolean; color?: string }
type Row = {
  key: string
  /** A group line (an agent's name and count), drawn without glyph, button or tag. */
  header?: boolean
  headerColor?: string
  glyph: string
  glyphColor: string
  text: string
  muted: boolean
  tag: string
  tagColor?: string
  details: Detail[]
  fill?: { topic: string; question: string; rec?: string }
  /** Your own to-do: its box is a button that checks it off, or back on. */
  check?: { item: string; done: boolean }
  matches: LedgerFilter[]
}
type TopicView = {
  id: string
  name: string
  glyph: string
  glyphColor: string
  chip?: string
  chipColor?: string
  chipText: string
  sub: string
  counts: string
  countColor: string
  isOpen: boolean
  sections: { label: string; rows: Row[]; isOpen: boolean }[]
}

// Where a line breaks: the last space that fits, so the second part continues the sentence.
const split = (s: string, n: number): [string, string] => {
  if (s.length <= n) return [s, '']
  const space = s.lastIndexOf(' ', n)
  const at = space > n / 2 ? space : n
  return [s.slice(0, at).trimEnd(), s.slice(at).trimStart()]
}

const clip = (s: string, n: number) => (s.length > n ? `${split(s, n - 1)[0]}…` : s)

const STATUS_GLYPH: Record<string, [string, string]> = {
  now: ['●', ACC],
  exploring: ['○', BLUE],
  shaped: ['◇', TEAL],
  chosen: ['◆', ACC],
  hold: ['‖', VIO],
  rejected: ['×', GREY],
  review: ['◐', AMB],
  done: ['✓', OK],
}
const COLUMN_COLOR: Record<string, string> = {
  backlog: GREY,
  planning: BLUE,
  ready: TEAL,
  building: ACC,
  review: AMB,
  done: OK,
}
const ORDER: Record<string, number> = { now: 0, rejected: 2, done: 2 }

const STATUS_LABEL: Record<string, string> = {
  now: 'now',
  exploring: 'exploring',
  shaped: 'shaped',
  chosen: 'chosen',
  hold: 'on hold',
  rejected: 'rejected',
  review: 'in review',
  done: 'done',
}

type LegendKey = { glyph: string; color: string; label: string }

// The key for the topic statuses in use right now.
export const legendFor = (doc: LedgerDoc): { name: string; keys: LegendKey[] }[] => {
  const statuses = Object.keys(STATUS_LABEL).filter((s) => doc.topics.some((t) => t.status === s))
  const keys = statuses.map((s) => ({ glyph: STATUS_GLYPH[s]![0], color: STATUS_GLYPH[s]![1], label: STATUS_LABEL[s]! }))
  return keys.length ? [{ name: 'topics', keys }] : []
}

const itemRow = (t: LedgerTopic, i: LedgerItem, card: LedgerCard | undefined): Row => {
  const owner = i.owner === 'you' ? 'YOU' : 'CLAUDE'
  if (i.kind === 'decided') {
    const logged = t.card ? (isLogged(i, card) ? `Logged on ${t.card}` : `Not on ${t.card} yet`) : undefined
    return {
      // Its own key, so a question opened to answer it lands in Decided folded.
      key: `${i.id}:d`,
      glyph: '✓',
      glyphColor: OK,
      text: i.text,
      muted: false,
      tag: '',
      details: [
        { t: `"${i.quote}"`, italic: true, color: '#d9dce1' },
        ...(i.detail ? [{ t: i.detail }] : []),
        ...(logged ? [{ t: logged }] : []),
      ],
      matches: ['all'],
    }
  }
  if (i.kind === 'question') {
    return {
      key: i.id,
      glyph: '?',
      glyphColor: ACC,
      text: i.text,
      muted: !!i.done,
      tag: i.done ? 'dropped' : owner,
      tagColor: GREY,
      details: i.done
        ? [{ t: i.detail ?? 'No longer matters' }]
        : [
            { t: 'Not answered yet' },
            ...(i.rec ? [{ t: `Recommended: ${i.rec}`, color: '#c9ccd2' }] : []),
            ...(i.detail ? [{ t: i.detail }] : []),
          ],
      fill: !i.done && i.owner === 'you' ? { topic: t.name, question: i.text, rec: i.rec } : undefined,
      matches: i.done ? ['all'] : ['all', i.owner === 'you' ? 'you' : 'claude'],
    }
  }
  if (i.kind === 'todo') {
    return {
      key: i.id,
      glyph: i.done ? '☑' : '☐',
      glyphColor: i.done ? OK : i.owner === 'you' ? ACC : GREY,
      text: stepText(i),
      muted: !!i.done,
      tag: i.done ? 'done' : i.agent ? '' : owner,
      tagColor: OK,
      details: [
        ...(i.full && i.full !== i.text ? [{ t: i.full, color: '#c9ccd2' }] : []),
        ...(i.detail ? [{ t: i.detail }] : [{ t: i.done ? 'Done' : 'Open' }]),
      ],
      matches: i.done ? ['all'] : ['all', i.owner === 'you' ? 'you' : 'claude'],
      ...(i.owner === 'you' ? { check: { item: i.id, done: !!i.done } } : {}),
    }
  }
  return { key: i.id, glyph: '·', glyphColor: GREY, text: i.text, muted: true, tag: '', details: [], matches: ['all'] }
}

const boardRows = (t: LedgerTopic, board: LedgerBoard | null, gaps: Gap[]): Row[] => {
  const rows: Row[] = []
  const mine = gaps.filter((g) => g.topicId === t.id)
  const card = t.card ? board?.cards[t.card] : undefined
  if (card) {
    const waiting = card.awaiting ?? card.nextAction ?? card.trigger
    rows.push({
      key: `${t.id}:card`,
      glyph: '▣',
      glyphColor: COLUMN_COLOR[card.status] ?? GREY,
      text: card.id,
      muted: false,
      tag: card.status,
      tagColor: COLUMN_COLOR[card.status] ?? GREY,
      details: [
        { t: card.title, color: '#c9ccd2' },
        ...(waiting ? [{ t: `${card.awaiting ? 'Awaiting' : card.nextAction ? 'Next' : 'Trigger'}: ${waiting}` }] : []),
        ...(card.lastLog ? [{ t: `Last log: ${card.lastLog}` }] : []),
      ],
      matches: ['all', 'board'],
    })
  }
  mine.forEach((g, n) =>
    rows.push({
      key: `${t.id}:gap${n}`,
      glyph: '⚠',
      glyphColor: AMB,
      text: g.text,
      muted: false,
      tag: 'gap',
      tagColor: AMB,
      details: [{ t: 'Claude sees this gap too and closes it in the work.' }],
      matches: ['all', 'board'],
    }),
  )
  if (card) {
    board!.changes
      .filter((c) => c.card === card.id)
      .slice(-3)
      .forEach((c, n) =>
        rows.push({
          key: `${t.id}:chg${n}`,
          glyph: '↻',
          glyphColor: BLUE,
          text: `${c.by === 'claude' ? 'Claude' : 'Another session'} ${c.text}`,
          muted: c.by === 'claude',
          tag: c.by === 'claude' ? 'Claude' : 'other session',
          tagColor: BLUE,
          details: [{ t: new Date(c.at).toLocaleTimeString() }],
          matches: ['all', 'board'],
        }),
      )
    if (!mine.length) rows.push({ key: `${t.id}:sync`, glyph: '✓', glyphColor: GREY, text: 'Card in sync with this session', muted: true, tag: '', details: [], matches: ['all', 'board'] })
  } else if (t.exempt) {
    rows.push({ key: `${t.id}:exempt`, glyph: '✓', glyphColor: GREY, text: 'No board card: exempt', muted: true, tag: '', details: [], matches: ['all', 'board'] })
  }
  return rows
}

// TO-DO rows: steps sorted by number and grouped under one header per agent (name, done of
// total, FINISHED when the agent stopped with steps open); steps with no agent follow, untagged
// by agent but still tagged by owner.
const todoRows = (t: LedgerTopic, card: LedgerCard | undefined, finished: ReadonlySet<string>): Row[] => {
  const todos = t.items.filter((i) => i.kind === 'todo').slice().sort((a, b) => compareTasks(a.task, b.task))
  const agents: string[] = []
  for (const i of todos) if (i.agent && !agents.includes(i.agent)) agents.push(i.agent)
  const out: Row[] = []
  for (const a of agents) {
    const mine = todos.filter((i) => i.agent === a)
    const done = mine.filter((i) => i.done).length
    const stopped = finished.has(a) && done < mine.length
    out.push({
      key: `${t.id}:agent:${a}`,
      header: true,
      headerColor: stopped ? AMB : done === mine.length ? OK : TEAL,
      glyph: '',
      glyphColor: GREY,
      text: `@${a} · ${done} of ${mine.length}${stopped ? ' · FINISHED, steps still open' : done === mine.length ? ' · done' : ''}`,
      muted: false,
      tag: '',
      details: [],
      matches: ['all', 'claude'],
    })
    out.push(...mine.map((i) => itemRow(t, i, card)))
  }
  const mine = todos.filter((i) => !i.agent)
  // Steps with no agent are the lead's; under agent groups they get their own header so they
  // never read as the last agent's.
  if (mine.length && agents.length) {
    const done = mine.filter((i) => i.done).length
    out.push({
      key: `${t.id}:agent:lead`,
      header: true,
      headerColor: done === mine.length ? OK : TEAL,
      glyph: '',
      glyphColor: GREY,
      text: `lead · ${done} of ${mine.length}${done === mine.length ? ' · done' : ''}`,
      muted: false,
      tag: '',
      details: [],
      matches: ['all', 'claude'],
    })
  }
  out.push(...mine.map((i) => itemRow(t, i, card)))
  return out
}

export const buildView = (
  doc: LedgerDoc,
  board: LedgerBoard | null,
  open: Record<string, boolean>,
  filter: LedgerFilter,
  finished: ReadonlySet<string> = new Set(),
): { topics: TopicView[]; you: number; claude: number; gaps: number } => {
  const gaps = gapsFor(doc, board)
  let you = 0
  let claude = 0
  const topics: TopicView[] = []
  const ordered = [...doc.topics].sort((a, b) => (ORDER[a.status] ?? 1) - (ORDER[b.status] ?? 1))

  const pushTopic = (base: Omit<TopicView, 'isOpen' | 'sections' | 'counts' | 'countColor'>, groups: [string, Row[]][], defaultOpen: boolean) => {
    const all = groups.flatMap(([, rows]) => rows)
    const y = all.filter((r) => r.matches.includes('you')).length
    const c = all.filter((r) => r.matches.includes('claude')).length
    const g = all.filter((r) => r.tag === 'gap').length
    you += y
    claude += c
    const hits = all.filter((r) => r.matches.includes(filter))
    if (filter !== 'all' && hits.length === 0) return
    const isOpen = filter !== 'all' ? true : open[`t:${base.id}`] ?? defaultOpen
    const parts = [y ? `${y} for you` : '', c ? `${c} Claude` : '', g ? `${g} gap` : ''].filter(Boolean)
    topics.push({
      ...base,
      counts: parts.length ? parts.join(' · ') : 'nothing open',
      countColor: g ? AMB : y ? ACC : GREY,
      isOpen,
      sections: isOpen
        ? groups
            // Decided starts folded: a topic's open work shows first, its history one press away.
            .map(([label, rows]) => ({ label, rows: rows.filter((r) => r.matches.includes(filter)), isOpen: open[`s:${base.id}:${label}`] ?? label !== 'DECIDED' }))
            .filter((s) => s.rows.length)
        : [],
    })
  }

  for (const t of ordered) {
    const card = t.card ? board?.cards[t.card] : undefined
    const rows = (kind: LedgerItem['kind']) => t.items.filter((i) => i.kind === kind).map((i) => itemRow(t, i, card))
    const [glyph, glyphColor] = STATUS_GLYPH[t.status] ?? ['○', BLUE]
    const missing = t.card && board?.found && !card
    pushTopic(
      {
        id: t.id,
        name: t.name,
        glyph,
        glyphColor,
        chip: card ? card.status.toUpperCase() : undefined,
        chipColor: card ? COLUMN_COLOR[card.status] ?? GREY : undefined,
        chipText: missing ? 'card missing' : t.card ? '' : t.exempt ? 'exempt' : 'no card',
        sub: [t.status, t.card ?? (t.exempt ? 'no card, exempt' : 'no card'), card?.campaign].filter(Boolean).join(' · '),
      },
      [
        ['DECIDED', rows('decided')],
        ['OPEN QUESTIONS', rows('question')],
        ['TO-DO', todoRows(t, card, finished)],
        ['BOARD', boardRows(t, board, gaps)],
        ['LEARNED', rows('learned')],
      ],
      t.status === 'now',
    )
  }

  if (board?.rulings.length) {
    pushTopic(
      {
        id: '_rulings',
        name: 'Board rulings waiting on you',
        glyph: '⚖',
        glyphColor: ACC,
        chipText: '',
        sub: 'cards in the same campaigns, outside this session',
      },
      [
        [
          'BOARD',
          board.rulings.map((r) => ({
            key: `ruling:${r.id}`,
            glyph: '⚖',
            glyphColor: ACC,
            text: r.id,
            muted: false,
            tag: 'YOU',
            details: [{ t: r.title, color: '#c9ccd2' }, ...(r.nextAction ? [{ t: r.nextAction }] : [])],
            fill: { topic: r.id, question: r.nextAction ?? r.title },
            matches: ['all', 'you', 'board'] as LedgerFilter[],
          })),
        ],
      ],
      false,
    )
  }

  return { topics, you, claude, gaps: gaps.length }
}
