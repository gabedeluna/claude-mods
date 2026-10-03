export type LedgerOwner = 'you' | 'claude'
export type LedgerItemKind = 'decided' | 'question' | 'todo' | 'learned'
export type LedgerStatus =
  | 'now'
  | 'exploring'
  | 'shaped'
  | 'chosen'
  | 'hold'
  | 'rejected'
  | 'review'
  | 'done'

export type LedgerItem = {
  id: string
  kind: LedgerItemKind
  text: string
  quote?: string
  owner?: LedgerOwner
  done?: boolean
  detail?: string
  rec?: string
  logged?: boolean
  turn?: number
  agent?: string
  task?: string
  full?: string
}

export type LedgerTopic = {
  id: string
  name: string
  status: LedgerStatus
  card?: string
  exempt?: boolean
  change?: string
  seq: number
  items: LedgerItem[]
}

export type LedgerDoc = {
  v: 1
  title: string
  hold?: string
  topics: LedgerTopic[]
  updatedTurn: number
}

export type LedgerCard = {
  id: string
  title: string
  status: string
  campaign?: string
  awaiting?: string
  nextAction?: string
  trigger?: string
  lastLog?: string
  logTexts: string[]
  logCount: number
  decision: boolean
}

export type LedgerChange = { card: string; text: string; by: 'claude' | 'other'; at: number }

export type LedgerRuling = { id: string; title: string; campaign?: string; nextAction?: string }

export type LedgerBoard = {
  found: boolean
  path: string
  cards: Record<string, LedgerCard>
  rulings: LedgerRuling[]
  changes: LedgerChange[]
}

export type LedgerFilter = 'all' | 'you' | 'claude' | 'board'

declare module 'claude-code' {
  interface PluginState {
    ledger: {
      doc: LedgerDoc
      board: LedgerBoard | null
      open: Record<string, boolean>
      filter: LedgerFilter
      turns: number
      finished: string[]
    }
  }
}
