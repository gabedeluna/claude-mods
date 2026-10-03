export type SideKind = 'ask' | 'recap' | 'now' | 'more' | 'followup'

export type SideDrawing = { title: string; svg: string; url?: string }

export type SideEntry = {
  id: string
  kind: SideKind
  // What was asked, as the panel shows it (the question, or the copied passage).
  title: string
  answer: string
  reads: string[]
  drawing?: SideDrawing
  // A board change the side chat proposed: nothing is written until the person approves it.
  proposal?: SideProposal
  failed?: boolean
}

export type SideProposal = {
  ops: Record<string, unknown>[]
  lines: string[]
  status: 'pending' | 'applied' | 'discarded' | 'failed'
  result?: string
}

export type SideRunning = { tool: string; summary: string; startedAt: number }

export type SideChat = {
  entries: SideEntry[]
  // What the panel is doing right now, shown while a reply is on its way; empty when idle.
  busy: string
}

declare module 'claude-code' {
  interface PluginState {
    sidechat: {
      chat: SideChat
      running: SideRunning | null
      tick: number
      box: boolean
      blink: boolean
    }
  }
}
