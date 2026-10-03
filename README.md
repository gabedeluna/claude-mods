# claude-mods

Two Claude Code mods.

## Install

In a terminal:

```
claude plugin marketplace add gabedeluna/claude-mods
claude plugin install ledger@claude-mods
claude plugin install sidechat@claude-mods
```

Then restart Claude Code.

## ledger

A running record of the session, kept by Claude as you work: topics, the decisions you made (quoted in your own words), open questions with a recommended answer and buttons to answer them, and to-dos for you and for Claude, ticked off as they get done. `/ledger` opens the panel.

## sidechat

A side panel for questions about the session that never reach the main conversation. `/sidechat <question>` opens it and asks; `recap`, `now` and `more` (explains the text you last copied) are buttons at the top. Answers can look up files and code, follow-up buttons go deeper, Draw it turns an answer into a diagram, and Send to main writes a note into your prompt. Click the box at the bottom to type; Enter sends, Shift+Enter adds a line.

On Windows Terminal, Shift+Enter needs a key setting: add an action that sends `\u001b\r` on `shift+enter` in the terminal's settings.json.
