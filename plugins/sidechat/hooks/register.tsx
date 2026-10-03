import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { SideChat, SideEntry, SideKind, SideRunning } from '../types'
import {
  FOLLOW_UPS,
  KIND_LABEL,
  MAX_ROUNDS,
  buildPrompt,
  capText,
  drawPrompt,
  drawingPage,
  elapsed,
  isSecretPath,
  lookupLabel,
  moreQuestion,
  nowQuestion,
  parseDrawing,
  parseLookups,
  parseProposal,
  boardOutcome,
  recapQuestion,
  sendToMainPrompt,
  SPIN_MS,
  busyLabel,
  spinFrame,
  sliceLines,
  summarizeCall,
} from './logic'
import type { Lookup } from './logic'

type Env = EngineInterface

const PANE = 'sidechat'
const ACC = '#e0905f'
const AMB = '#e8c06a'
const BLUE = '#79b8ff'
const GREY = '#8b929c'
const FAINT = '#5f6672'

const chatA = atom({ plugin: 'sidechat', key: 'chat' } as const, { entries: [], busy: '' } as SideChat)
const runningA = atom({ plugin: 'sidechat', key: 'running' } as const, null as SideRunning | null)
const tickA = atom({ plugin: 'sidechat', key: 'tick' } as const, 0)
// Whether the message box was last clicked or typed in, so it shows a blinking cursor.
const boxA = atom({ plugin: 'sidechat', key: 'box' } as const, false)
const blinkA = atom({ plugin: 'sidechat', key: 'blink' } as const, true)

// Selects or clears the box; the cursor blinks on a timer only while it is selected.
async function setBox($: Env, on: boolean) {
  if (on && !blinker) blinker = $.clock.every(BLINK_MS, () => void update($, blinkA, (b) => !b))
  if (!on && blinker) {
    blinker.cancel()
    blinker = undefined
  }
  await update($, blinkA, () => true)
  await update($, boxA, () => on)
}

let sessionId = ''
let root = ''
let boardScript = ''
let asked = 0
const calls = new Map<string, SideRunning>()
let ticker: { cancel: () => void } | undefined
let spinner: { cancel: () => void } | undefined
let blinker: { cancel: () => void } | undefined
const BLINK_MS = 530
let busySince = 0

const newId = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`

async function save($: Env) {
  if (!sessionId) return
  const chat = await read($, chatA)
  await $.store.set(`chat:${sessionId}`, { entries: chat.entries.slice(-30), busy: '' })
  const ids = ((await $.store.get('sessions')) as string[] | undefined) ?? []
  const next = [...ids.filter((i) => i !== sessionId), sessionId]
  for (const old of next.slice(0, Math.max(0, next.length - 30))) await $.store.delete(`chat:${old}`)
  await $.store.set('sessions', next.slice(-30))
}

async function setEntry($: Env, id: string, patch: Partial<SideEntry>) {
  await update($, chatA, (c) => ({ ...c, entries: c.entries.map((x) => (x.id === id ? { ...x, ...patch } : x)) }))
}

// While busy, a timer moves the star; the start time stays put while the busy text changes.
async function setBusy($: Env, busy: string) {
  if (busy && !spinner) {
    busySince = await $.clock.now()
    spinner = $.clock.every(SPIN_MS, () => void update($, tickA, (t) => t + 1))
  }
  if (!busy && spinner) {
    spinner.cancel()
    spinner = undefined
  }
  await update($, chatA, (c) => ({ ...c, busy }))
}

async function findBoardScript($: Env): Promise<string> {
  let dir = root
  for (let i = 0; i < 5; i += 1) {
    const p = `${dir}/../Telify-board/docs/board/board.mjs`
    if (await $.fs.exists(p)) return p
    dir = `${dir}/..`
  }
  return ''
}

// Found once, when first needed, so a reload or a fresh panel still reaches the board.
async function ensureBoard($: Env): Promise<string> {
  if (!root) root = (await $.session.root()).replace(/\\/g, '/')
  if (!boardScript) boardScript = await findBoardScript($)
  return boardScript
}

const abs = (p: string) => (/^([a-zA-Z]:)?[\\/]/.test(p) ? p : `${root}/${p.replace(/^\.\//, '')}`)

// Read-only lookups the side chat asks for.
async function runLookup($: Env, l: Lookup): Promise<string> {
  try {
    if (l.kind === 'read') {
      if (isSecretPath(l.path)) return 'Not read: secret files stay out of the side chat.'
      return capText(sliceLines((await $.fs.read(abs(l.path))) as string, l.from, l.to))
    }
    if (l.kind === 'list') {
      const entries = await $.fs.list(abs(l.path))
      return entries.slice(0, 200).map((x) => `${x.name}${x.kind === 'dir' ? '/' : ''}`).join('\n') || '(empty)'
    }
    if (l.kind === 'search') {
      const argv = ['git', 'grep', '-n', '-I', '-F', '--max-count=5', '-e', l.text, '--', ...(l.path ? [l.path] : [])]
      const r = await $.process.run(argv, { cwd: root, timeoutMs: 20000 })
      const lines = r.stdout.split(/\r?\n/).filter(Boolean).filter((x) => !isSecretPath(x.split(':')[0] ?? ''))
      return lines.length ? capText(lines.slice(0, 60).join('\n') + (lines.length > 60 ? `\n[${lines.length - 60} more matches]` : '')) : 'No matches.'
    }
    if (l.kind === 'board') {
      if (!(await ensureBoard($))) return 'No board found beside this project.'
      const op = /^[a-z0-9]+(-[a-z0-9]+)+$/.test(l.query) ? { op: 'show', id: l.query } : { op: 'find', text: l.query, limit: 12 }
      const r = await $.process.run(['node', boardScript, '-'], { stdin: JSON.stringify({ ops: [op] }), timeoutMs: 30000 })
      return capText((r.stdout || r.stderr).trim())
    }
    const r = await $.tool.call({ tool: 'mcp__ledger__ledger', ops: [] } as never)
    const text = (r as { result?: unknown; deny?: string }).result ?? (r as { deny?: string }).deny
    return capText(typeof text === 'string' ? text : JSON.stringify(text ?? 'The ledger is not available.'))
  } catch (err) {
    return `Could not ${lookupLabel(l)}: ${err instanceof Error ? err.message : String(err)}`
  }
}

const failText = (reason: string) =>
  reason === 'nothing-to-fork'
    ? 'Nothing to ask about yet: the main conversation has no reply so far.'
    : reason === 'aborted'
      ? 'Stopped before it answered.'
      : `No answer (${reason}). Try again.`

// One side question: ask, run any lookups it requests, ask again, up to MAX_ROUNDS.
async function ask($: Env, kind: SideKind, title: string, question: string) {
  const chat = await read($, chatA)
  if (chat.busy) {
    await $.ui.toast('The side chat is still answering the last question.')
    return
  }
  const history = chat.entries
  const id = newId()
  asked += 1
  await update($, chatA, (c) => ({ ...c, entries: [...c.entries, { id, kind, title, answer: '', reads: [] }] }))
  await setBusy($, 'thinking…')
  await toEnd($)
  const looked: { line: string; result: string }[] = []
  const reads: string[] = []
  try {
    for (let round = 0; round <= MAX_ROUNDS; round += 1) {
      const prompt = buildPrompt({ question, history, running: await read($, runningA), now: await $.clock.now(), looked, final: round === MAX_ROUNDS })
      const r = await $.model.fork({ prompt })
      if (!r.isAnswered) {
        await setEntry($, id, { answer: failText(r.reason), failed: true, reads })
        return
      }
      const req = round < MAX_ROUNDS ? parseLookups(r.text) : null
      if (!req) {
        const { answer, proposal, error } = parseProposal(r.text.trim())
        await setEntry($, id, {
          answer: error ? `${answer}

(It tried to propose a board change, but ${error}. Ask again.)` : answer,
          reads,
          ...(proposal ? { proposal: { ...proposal, status: 'pending' as const } } : {}),
        })
        await toEnd($)
        return
      }
      for (const [n, l] of req.lookups.entries()) {
        const label = lookupLabel(l)
        await setBusy($, `${label}…`)
        looked.push({ line: req.lines[n] ?? label, result: await runLookup($, l) })
        reads.push(label)
        await setEntry($, id, { reads: [...reads] })
      }
      await setBusy($, 'thinking…')
    }
  } catch (err) {
    await setEntry($, id, { answer: `No answer: ${err instanceof Error ? err.message : String(err)}`, failed: true, reads })
  } finally {
    await setBusy($, '')
    await save($)
  }
}

// Keeps the newest line of the conversation in view.
async function toEnd($: Env) {
  await $.ui.scroll({ in: PANE, to: 'end' }).catch(() => undefined)
}

const later = ($: Env, fn: () => Promise<void>) => {
  $.clock.after(0, () => void fn())
}

async function recap($: Env) {
  await ask($, 'recap', 'Recap of the session', recapQuestion)
}

async function whatNow($: Env) {
  await ask($, 'now', 'What the main thread is doing', nowQuestion)
}

// The clipboard's text, through whichever reader this machine has: Windows, Mac, then Linux (X11, Wayland).
const CLIPBOARD_READERS = [
  ['powershell', '-NoProfile', '-Command', 'Get-Clipboard -Raw'],
  ['pbpaste'],
  ['xclip', '-o', '-selection', 'clipboard'],
  ['wl-paste', '--no-newline'],
]

async function copied($: Env): Promise<string> {
  const windows = (await $.env.get('OS').catch(() => undefined)) === 'Windows_NT'
  for (const argv of windows ? CLIPBOARD_READERS.slice(0, 1) : CLIPBOARD_READERS.slice(1)) {
    const r = await $.process.run(argv, { timeoutMs: 10000 }).catch(() => undefined)
    if (r && r.exitCode === 0 && r.stdout.trim()) return r.stdout.trim()
  }
  return ''
}

async function more($: Env) {
  const passage = await copied($)
  if (!passage) {
    await $.ui.toast('Copy some text from the conversation first, then press more.')
    return
  }
  const clipped = passage.length > 160 ? `${passage.slice(0, 157)}…` : passage
  await ask($, 'more', `"${clipped}"`, moreQuestion(passage.slice(0, 4000)))
}

async function followUp($: Env, key: string) {
  const chat = await read($, chatA)
  const last = [...chat.entries].reverse().find((x) => !x.failed && x.answer)
  if (!last) return
  if (key === 'draw') return draw($, last.id)
  const f = FOLLOW_UPS.find((x) => x.key === key)
  if (!f) return
  await ask($, 'followup', f.says, `${f.ask} (This follows up your last side answer, to: ${last.title})`)
}

const urlIn = (r: unknown) => /https:\/\/claude\.ai\/(?:code\/)?artifact\/[A-Za-z0-9-]+/.exec(JSON.stringify(r))?.[0]

async function draw($: Env, entryId: string) {
  const chat = await read($, chatA)
  const entry = chat.entries.find((x) => x.id === entryId)
  if (!entry || chat.busy) return
  await setBusy($, 'drawing…')
  try {
    const r = await $.model.fork({ prompt: drawPrompt(entry) })
    const drawing = r.isAnswered ? parseDrawing(r.text) : null
    if (!drawing) {
      await $.ui.toast('The side chat could not draw that one. Try again, or ask it differently.')
      return
    }
    await setEntry($, entryId, { drawing })
    const dir = ((await $.env.get('TEMP')) ?? (await $.env.get('TMPDIR')) ?? root).replace(/\\/g, '/')
    const file = `${dir}/sidechat-${entryId}.html`
    await $.fs.write(file, drawingPage(drawing.title, drawing.svg))
    await setBusy($, 'publishing the drawing…')
    const published = await $.tool.call({
      tool: 'Artifact',
      file_path: file,
      icon: 'diagram',
      description: `Side chat drawing: ${drawing.title}`,
      consent: 'The user pressed "Draw it" in the side chat panel to publish this diagram as a private artifact.',
    } as never)
    const url = urlIn(published)
    if (url) await setEntry($, entryId, { drawing: { ...drawing, url } })
    else await $.ui.toast('Drawn, but publishing it as an artifact did not go through.')
    await toEnd($)
  } finally {
    await setBusy($, '')
    await save($)
  }
}

// Writes a proposed board change only when the person presses Approve, through the board script and its checks.
async function approveBoard($: Env, entryId: string) {
  const chat = await read($, chatA)
  const entry = chat.entries.find((x) => x.id === entryId)
  const p = entry?.proposal
  if (!p || p.status !== 'pending' || chat.busy) return
  if (!(await ensureBoard($))) {
    await setEntry($, entryId, { proposal: { ...p, status: 'failed', result: 'No board found beside this project.' } })
    return
  }
  await setBusy($, 'changing the board…')
  try {
    const r = await $.process.run(['node', boardScript, '-'], { stdin: JSON.stringify({ ops: p.ops }), timeoutMs: 60000 })
    const result = (r.stdout || r.stderr).trim()
    await setEntry($, entryId, { proposal: { ...p, status: r.exitCode === 0 ? 'applied' : 'failed', result } })
  } finally {
    await setBusy($, '')
    await save($)
    await toEnd($)
  }
}

async function discardBoard($: Env, entryId: string) {
  const entry = (await read($, chatA)).entries.find((x) => x.id === entryId)
  if (entry?.proposal?.status !== 'pending') return
  await setEntry($, entryId, { proposal: { ...entry.proposal, status: 'discarded' } })
  await save($)
}

async function openArtifact($: Env, url: string) {
  await $.tool.call({ tool: 'Artifact', action: 'open', url, consent: 'The user pressed "Open artifact" in the side chat panel.' } as never)
}

// Puts text in the prompt box, after anything already typed there.
async function fillPrompt($: Env, text: string) {
  const box = await $.prompt.read()
  const draft = box.text.trimEnd()
  await $.prompt.fill({ text: draft ? `${draft}\n${text}` : text })
}

async function sendToMain($: Env) {
  const chat = await read($, chatA)
  if (!chat.entries.some((x) => !x.failed && x.answer) || chat.busy) return
  await setBusy($, 'writing a note for the main thread…')
  try {
    const r = await $.model.fork({ prompt: sendToMainPrompt(chat.entries) })
    if (r.isAnswered && r.text.trim()) {
      await fillPrompt($, r.text.trim())
      await $.ui.toast('A note from the side chat is in your prompt. Edit it, then send.')
    } else await $.ui.toast('Could not write the note. Try again.')
  } finally {
    await setBusy($, '')
  }
}

async function newChat($: Env) {
  await update($, chatA, () => ({ entries: [], busy: '' }))
  await save($)
}

async function openPane($: Env) {
  await $.ui.open({ id: PANE, title: 'Side chat', focus: true, columns: 66 })
  // Typing goes straight into the side chat's box where the surface allows it.
  await $.ui.focus({ requestId: PANE, key: 'composer' }).catch(() => undefined)
}

// The newest of the main thread's tool calls still running.
async function showRunning($: Env) {
  const latest = [...calls.values()].sort((a, b) => b.startedAt - a.startedAt)[0] ?? null
  await update($, runningA, () => latest)
  if (latest && !ticker) ticker = $.clock.every(1000, () => void update($, tickA, (t) => t + 1))
  if (!latest && ticker) {
    ticker.cancel()
    ticker = undefined
  }
}

export const register: Register = (on) => {
  // The terminal box posts a message when Enter sends it.
  on('ui.message', async ($, e, next) => {
    if (e.requestId !== PANE || e.element !== 'composer') return next(e)
    const data = e.data as { submit?: unknown; focus?: unknown } | null
    if (data?.focus) await setBox($, true)
    const text = data?.submit
    if (typeof text === 'string' && text.trim()) later($, () => ask($, 'ask', text.trim(), text.trim()))
    return {}
  })

  // Tab onto a button moves the selection off the box.
  on('ui.focus', async ($, e, next) => {
    if (e.requestId === PANE && e.element && e.element !== 'composer') await setBox($, false)
    return next(e)
  })

  // Typing in the main prompt means Esc handed the keys back there.
  on('prompt.edit', async ($, e, next) => {
    if (await read($, boxA)) await setBox($, false)
    return next(e)
  })

  on('ui.close', async ($, e, next) => {
    if (e.id === PANE) await setBox($, false)
    return next(e)
  })

  on('session.start', async ($, e, next) => {
    sessionId = await $.session.id()
    root = (await $.session.root()).replace(/\\/g, '/')
    boardScript = await findBoardScript($)
    const held = await read($, chatA)
    if (!held.entries.length) {
      const stored = (await $.store.get(`chat:${sessionId}`)) as SideChat | undefined
      if (stored?.entries?.length) await update($, chatA, () => ({ entries: stored.entries, busy: '' }))
    } else if (held.busy) await setBusy($, '')
    await $.command.register({ name: 'sidechat', description: 'Ask about this session in a side panel (recap · now · more · a question)', argumentHint: '[question|recap|now|more]' })
    return next(e)
  })

  on('command.run', { command: 'sidechat' }, async ($, e) => {
    const arg = e.args.trim()
    await openPane($)
    if (arg === 'recap') later($, () => recap($))
    else if (arg === 'now') later($, () => whatNow($))
    else if (arg === 'more') later($, () => more($))
    else if (arg) later($, () => ask($, 'ask', arg, arg))
    return {}
  })

  // What the main thread is running, for the Now strip and the side chat's own context.
  on('tool.call', async ($, e, next) => {
    const id = e.tool_use_id
    if (e.agentId || !id || String(e.tool).startsWith('mcp__sidechat')) return next(e)
    calls.set(id, { tool: String(e.tool), summary: summarizeCall(String(e.tool), e as unknown as Record<string, unknown>), startedAt: await $.clock.now() })
    await showRunning($)
    try {
      return await next(e)
    } finally {
      calls.delete(id)
      await showRunning($)
    }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const chat = await read($, chatA)
    const running = await read($, runningA)
    await read($, tickA)
    const boxHot = await read($, boxA)
    // Selected from a click or key in it; the panel's own keyboard flag is off while the box has the keys.
    const boxFocused = boxHot
    const blink = await read($, blinkA)
    const now = await $.clock.now()
    const W = Math.max(30, e.props.bodyColumns - 2)
    const desktop = e.surface === 'desktop'
    const { Box, Text, Button, Input, Markdown, Svg, Client } = $.ui.resolve(e) as Record<string, any>
    const entries = chat.entries
    const latest = entries.at(-1)
    const band = desktop ? '#e9e4d8' : '#2f3b52'
    const settled = latest && !chat.busy && latest.answer && !latest.failed
    const go = (fn: () => Promise<void>) => () => later($, fn)

    const spinner = (
      <Box flexDirection="row" marginTop={1} paddingLeft={2}>
        <Text color={ACC}>{`${spinFrame(now - busySince)} `}</Text>
        <Text color={ACC}>{busyLabel(chat.busy)}</Text>
        <Text dimColor>{` (${elapsed(now - busySince)})`}</Text>
      </Box>
    )

    // One turn: your message on a band, then what it looked up, then its reply after a bullet.
    const turn = (x: SideEntry) => (
      <Box key={`t-${x.id}`} flexDirection="column" marginTop={1}>
        <Box flexDirection="row" backgroundColor={band} paddingX={1}>
          <Text color={ACC} bold>{'› '}</Text>
          <Box flexDirection="column" flexGrow={1}>
            {x.kind === 'recap' || x.kind === 'now' || x.kind === 'more' ? <Text dimColor>{KIND_LABEL[x.kind]}</Text> : null}
            <Text bold wrap="wrap">{x.title}</Text>
          </Box>
        </Box>
        {x.reads.map((r, i) => (
          <Text key={`rd-${x.id}-${i}`} color={GREY}>{`  ◦ ${r}`}</Text>
        ))}
        {x.answer ? (
          <Box flexDirection="row" marginTop={1}>
            <Text color={x.failed ? AMB : GREY}>{'● '}</Text>
            <Box flexDirection="column" flexGrow={1}>{x.failed ? <Text color={AMB}>{x.answer}</Text> : <Markdown text={x.answer} />}</Box>
          </Box>
        ) : null}
        {x.proposal ? (
          <Box flexDirection="column" marginTop={1} paddingLeft={2}>
            {x.proposal.status === 'pending' ? (
              [
                <Text key="h" bold color={BLUE}>{'▤ Proposed board change'}</Text>,
                ...x.proposal.lines.map((l, i) => (
                  <Text key={`pl-${x.id}-${i}`} wrap="wrap">{`  · ${l}`}</Text>
                )),
                <Box key="b" flexDirection="row" gap={2} marginTop={1}>
                  <Button key={`approve-${x.id}`} variant="primary" label="Approve" onPress={go(() => approveBoard($, x.id))} />
                  <Button key={`discard-${x.id}`} label="Discard" onPress={go(() => discardBoard($, x.id))} />
                </Box>,
              ]
            ) : (
              // Once it is settled, a line or two: the full text is on the board.
              boardOutcome(x.proposal).map((l, i) => (
                <Text key={`po-${x.id}-${i}`} bold={i === 0} color={i === 0 ? (x.proposal!.status === 'failed' ? AMB : x.proposal!.status === 'discarded' ? GREY : BLUE) : GREY} wrap="wrap">{l}</Text>
              ))
            )}
          </Box>
        ) : null}
        {x.drawing ? (
          <Box flexDirection="column" marginTop={1} paddingLeft={2}>
            {desktop && Svg ? <Svg source={x.drawing.svg} alt={x.drawing.title} width={W * 7} /> : null}
            <Box flexDirection="row">
              <Text color={BLUE}>{'▣ '}</Text>
              <Text bold>{`Drawn: ${x.drawing.title}  `}</Text>
              {x.drawing.url ? <Button key={`open-${x.id}`} variant="primary" label="Open artifact" onPress={go(() => openArtifact($, x.drawing!.url!))} /> : <Text dimColor>not published</Text>}
            </Box>
          </Box>
        ) : null}
      </Box>
    )

    return (
      <Box flexDirection="column" width={W}>
        <Box flexDirection="row">
          <Text color={ACC} bold>SIDECHAT</Text>
          <Box flexGrow={1} />
          <Button key="recap" plain label="recap" hotkey="r" onPress={go(() => recap($))} />
          <Text color={FAINT}>{' · '}</Text>
          <Button key="now" plain label="now" hotkey="n" onPress={go(() => whatNow($))} />
          <Text color={FAINT}>{' · '}</Text>
          <Button key="more" plain label="more" hotkey="m" onPress={go(() => more($))} />
        </Box>
        <Box flexDirection="row" marginTop={1}>
          {running ? (
            [
              <Text key="g" color={AMB}>{'◐ '}</Text>,
              <Text key="l" dimColor>{'Main is running: '}</Text>,
              <Text key="s" wrap="truncate-end">{running.summary || running.tool}</Text>,
              <Box key="f" flexGrow={1} />,
              <Text key="t" dimColor>{` ${elapsed(now - running.startedAt)}`}</Text>,
            ]
          ) : (
            <Text color={FAINT}>{'○ Main is not running a tool'}</Text>
          )}
        </Box>
        <Box flexDirection="column">
          {entries.length ? (
            entries.map(turn)
          ) : (
            <Box marginTop={1}>
              <Text dimColor wrap="wrap">{'Ask about anything in this session. Copy a passage and press more to have it explained. Nothing here reaches the main conversation unless you press Send to main.'}</Text>
            </Box>
          )}
          {chat.busy ? spinner : null}
          {settled ? (
            <Box flexDirection="row" flexWrap="wrap" marginTop={1} paddingLeft={2}>
              {FOLLOW_UPS.map((f, i) => (
                <Box key={`fw-${f.key}`} flexDirection="row">
                  {i ? <Text color={FAINT}>{' · '}</Text> : null}
                  <Button key={`f-${f.key}`} plain label={f.label} onPress={go(() => followUp($, f.key))} />
                </Box>
              ))}
            </Box>
          ) : null}
        </Box>
        <Box flexDirection="column" marginTop={1}>
          <Text color={FAINT}>{'─'.repeat(W)}</Text>
          <Box flexDirection="row" gap={2}>
            <Button key="send" variant="primary" label="Send to main" onPress={go(() => sendToMain($))} />
            <Button key="new" label="New chat" onPress={go(() => newChat($))} />
          </Box>
          {/* The side chat's own box where the surface can draw one; the plain field elsewhere. */}
          {Client ? (
            <Box flexDirection="column" marginTop={1}>
              <Client key="composer" module="./composer.tsx" props={{ placeholder: 'Ask about the main thread…', focused: boxFocused, blink }} />
              <Text color={FAINT}>{boxFocused ? '  enter send · shift+enter new line · esc back to the main prompt' : '  click the box to type'}</Text>
            </Box>
          ) : (
            <Input
              key={`ask-${asked}`}
              placeholder="Ask about the main thread…"
              submitLabel="Ask"
              autoFocus
              onSubmit={(value: string) => {
                const q = value.trim()
                if (q) later($, () => ask($, 'ask', q, q))
              }}
            />
          )}
        </Box>
      </Box>
    )
  })
}
