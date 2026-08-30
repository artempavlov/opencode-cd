# opencode-cd

OpenCode TUI plugin that changes the working directory of the current session
without creating a new session.

## Features

- Command palette entry: `Change session directory`.
- Slash commands: `/session-cd` and `/cd-session`.
- Keyboard shortcut: `Ctrl+Shift+D`.
- Absolute paths, home paths (`~`), and paths relative to the current session.
- Existing directories are checked before the move.
- Uncommitted Git changes require an explicit confirmation before transfer.
- The model receives a synthetic reminder about the new directory.

## Setup

Install dependencies:

```sh
bun install
```

Add the plugin file to the global OpenCode TUI configuration in
`~/.config/opencode/tui.json`:

```json
{
  "$schema": "https://opencode.ai/tui.json",
  "plugin": [
    "file:///path/to/opencode-cd/session-directory.tsx"
  ]
}
```

Restart OpenCode after changing the configuration.

The destination must belong to the same OpenCode project. OpenCode rejects a
move to an unrelated project.
