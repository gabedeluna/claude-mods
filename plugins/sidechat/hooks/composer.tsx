// The side chat's message box: it holds its own text and cursor, takes every key while it has the
// focus, wraps as it draws, and posts the message to the hooks module on Enter. While it is selected
// its border lights up and its cursor blinks on the panel's beat; a click or a key in it tells the
// hooks it is selected.
import type { ClientModule } from 'claude-code'

import { EMPTY, applyKey, cursorAt, wrap } from './editor'
import type { Ed } from './editor'

type Props = { placeholder: string; focused: boolean; blink: boolean }
// `solid` keeps the cursor on after a key until the next beat, as the main prompt's does.
// `live` is read by the listeners, which outlive any one draw.
type State = { ed: Ed; solid: boolean; beat: boolean; live: { focused: boolean } }

const ACC = '#e0905f'
const INK = '#16181d'
const TEXT = '#d4d7dd'
const LINE = '#3a3f4a'

const Composer: ClientModule<Props, State> = (props, surface) => {
  const { Box, Text } = surface.elements
  if (surface.state === undefined) {
    surface.setState({ ed: EMPTY, solid: false, beat: props.blink, live: { focused: props.focused } })
    surface.onKey((k) => {
      const s = surface.state
      if (!s) return
      const r = applyKey(s.ed, k, Math.max(10, surface.columns - 7))
      if (r.submit) surface.post({ submit: r.submit })
      else if (!s.live.focused) surface.post({ focus: true })
      surface.setState({ ...s, ed: r.ed, solid: true })
    })
    surface.onPointer((p) => {
      if (p.type === 'down' && !surface.state?.live.focused) surface.post({ focus: true })
    })
  }
  const state = surface.state ?? { ed: EMPTY, solid: false, beat: props.blink, live: { focused: props.focused } }
  state.live.focused = props.focused
  // A new beat from the panel ends the solid stretch after typing.
  if (state.beat !== props.blink) {
    state.beat = props.blink
    state.solid = false
  }
  const ed = state.ed
  const showCursor = props.focused && (props.blink || state.solid)
  // The box wraps the text itself; each drawn line is cut, never wrapped again by the terminal.
  const width = Math.max(10, surface.columns - 7)
  const lines = wrap(ed.text, width)
  const at = cursorAt(lines, ed.cursor)
  const cell = (ch: string, key: string) =>
    showCursor ? <Text key={key} backgroundColor={TEXT} color={INK}>{ch || ' '}</Text> : <Text key={key} color={TEXT}>{ch || ' '}</Text>

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={props.focused ? ACC : LINE} paddingX={1}>
      {ed.text ? (
        lines.map((l, row) => {
          const s = ed.text.slice(l.start, l.end).replace(/\n/g, '')
          return (
            <Box key={`l${row}`} flexDirection="row">
              <Text color={ACC}>{row === 0 ? '› ' : '  '}</Text>
              {/* Siblings in the row itself: a fragment would draw as a column and drop the cursor a line. */}
              {row === at.row
                ? [
                    <Text key="b" color={TEXT} wrap="truncate">{s.slice(0, at.col)}</Text>,
                    cell(s.charAt(at.col), 'c'),
                    <Text key="a" color={TEXT} wrap="truncate">{s.slice(at.col + 1)}</Text>,
                  ]
                : <Text color={TEXT} wrap="truncate">{s}</Text>}
            </Box>
          )
        })
      ) : (
        <Box flexDirection="row">
          <Text color={ACC}>{'› '}</Text>
          {cell('', 'c')}
          <Text dimColor>{props.focused ? props.placeholder : `${props.placeholder}  (click to type)`}</Text>
        </Box>
      )}
    </Box>
  )
}

export default Composer
