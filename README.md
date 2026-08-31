# opencode-cd

OpenCode TUI plugin that changes the working directory of the current session.
Moving between projects preserves the conversation in a replacement session.

## Features

- Command palette entry: `Change session directory`.
- Slash commands: `/session-cd` and `/cd-session`.
- Keyboard shortcut: `Ctrl+Shift+D`.
- Absolute paths, home paths (`~`), and paths relative to the current session.
- Existing directories are checked before the move.
- Uncommitted Git changes remain in the source directory.
- The model receives a synthetic reminder about the new directory.
- Cross-project moves use a verified export/import flow and then remove the
  source session.
- Cross-project moves include child sessions and rebuild their parent links.

## Setup

Install the plugin directly from GitHub:

```sh
opencode plugin opencode-cd@git+https://github.com/artempavlov/opencode-cd.git#main --global
```

For local development, install dependencies with `bun install` and add the
plugin file to the global OpenCode TUI configuration in
`~/.config/opencode/tui.json`:

```json
{
  "$schema": "https://opencode.ai/tui.json",
  "plugin": [
    "file:///path/to/opencode-cd/session-directory.ts"
  ]
}
```

Restart OpenCode after changing the configuration.
