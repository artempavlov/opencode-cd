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

Install the plugin from the GitHub checkout:

```sh
git clone https://github.com/artempavlov/opencode-cd.git /path/to/opencode-cd
```

For updates, run `git pull --ff-only` in the checkout. Install dependencies
with `bun install`, then add the plugin file to the global OpenCode TUI
configuration in
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
