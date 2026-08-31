# AGENTS.md

## Project Overview

`opencode-cd` is a TypeScript ESM plugin for the OpenCode TUI. Its entrypoint,
`session-directory.ts`, adds a command for changing the current session's
working directory. Same-project moves use OpenCode's native move API; moves to
another project, or moves with child sessions, use the verified migration flow
in `session-migration.ts`.

The repository targets the OpenCode 1.18.x API and pins
`@opencode-ai/plugin` to `1.18.25`. Bun and the OpenCode CLI are required for
the cross-project import path, but this repository does not pin their versions.

## Repository Structure

- `session-directory.ts` - TUI plugin registration, path resolution, directory
  checks, idle checks, move strategy, and user-facing toasts.
- `session-migration.ts` - session-tree discovery, destination model/agent
  selection, import-payload rewriting, CLI import, verification, and cleanup.
- `session-directory.test.ts` - path-independent tests for move strategy and
  idle-state handling.
- `session-migration.test.ts` - mocked migration tests for payload identity,
  child-session links, fallback settings, import failure, and source deletion
  failure.
- `README.md` - installation and local TUI configuration.
- `CROSS_PROJECT_SESSION_MIGRATION.md` - the detailed migration specification;
  use it when changing migration behavior.
- `package.json`, `tsconfig.json`, and `bun.lock` - package scripts,
  TypeScript settings, and locked dependencies.

There are no nested `AGENTS.md` files, application subdirectories, CI
workflows, or repository-defined build/lint/format/code-generation commands.

## Setup

Run from the repository root:

```sh
bun install
```

For manual TUI testing, add the plugin file to the global OpenCode TUI
configuration at `~/.config/opencode/tui.json` as described in `README.md`,
then restart OpenCode. The repository has no standalone development server.

## Development Commands

All commands below run from the repository root:

- `bun run typecheck` runs the configured `tsc` script. TypeScript uses strict
  checking, `NodeNext` modules, ES2022 output settings, and `noEmit`; the
  `tsconfig.json` include list names `session-directory.ts`, which pulls in its
  migration import transitively.
- `bun test` runs the complete Bun test suite (`*.test.ts` files in the root).
- `bun test session-directory.test.ts` runs the directory-command tests only.
- `bun test session-migration.test.ts` runs the migration tests only.

No repository command is defined for linting, formatting, building, migrations,
or generated-code checks. Do not present an equivalent global tool command as a
project command.

The runtime migration subprocess uses `OPENCODE_BIN` when set, otherwise it
executes `opencode import <temporary-json-file>` with the destination directory
as its working directory. This is an optional executable override, not a
credential setting.

## Architecture and Conventions

- The package is ESM (`"type": "module"`) and exports `session-directory.ts`
  for both `.` and `./tui`. Preserve the `.js` extension on local runtime
  imports used by the TypeScript source.
- The TUI entrypoint uses `TuiPluginApi` services (`state`, `client`, `ui`,
  `route`, and `keymap`). The registered command is `session.change_directory`
  with slash name `/session-cd`, alias `/cd-session`, and key binding
  `Ctrl+Shift+D`.
- User paths are trimmed, `~` is expanded, and relative paths resolve from the
  current session directory. The destination must already exist and be
  readable/searchable. The exact destination directory is retained even when
  its OpenCode project is the Git repository root.
- Native `controlPlane.moveSession` is selected only when source and
  destination project IDs match and the session has no children. It passes
  `moveChanges: false`, so source Git changes stay in the source directory.
- Migration reads the complete session tree and history, checks idle state,
  selects destination-compatible model/agent settings, creates temporary
  destination IDs, imports through the OpenCode CLI, verifies the result,
  checks continuation, and removes the source tree only after verification.
  Failed migrations attempt to remove partial destination sessions.
- Imported payloads clear source-only project/directory/permission and
  undo-related fields, rewrite session/message/part identities, preserve
  historical file references, and omit snapshot/patch parts. Child
  `parentID` values must point to the newly mapped destination parent.
- Destination model/agent fallbacks are reported as warnings. API failures are
  surfaced through TUI error toasts; model fallback prefers the merged
  destination config's default model before any other available model. Model
  compatibility uses the complete `config.providers` registry, not the
  UI-oriented `v2.model.list` catalog, which can omit plugin-provided models.
  Successful moves and non-fatal warnings use success/info/warning toasts.
- New child-session IDs preserve the source sibling-ID ordering because the TUI
  sorts sibling sessions lexicographically when cycling with arrow keys.
- Do not add JSX to the GitHub/npm-loaded TUI entrypoint. The migration
  specification records an OpenTUI runtime problem for JSX-loaded plugins
  under `node_modules`; the current entrypoint uses the non-JSX TUI API.

## Testing Guidelines

Tests use `bun:test` and are colocated at the repository root next to the
implementation. Migration tests inject a mocked API and an `importSession`
callback, so they do not require a live OpenCode server, Git repository, or
external model/agent configuration. Add regression coverage to the relevant
test file when changing move strategy, payload rewriting, verification,
fallback selection, or cleanup behavior.

The test suite currently covers same-project strategy, non-Git/global strategy,
busy sessions, child trees, unavailable model/agent fallback, successful
import, partial-import cleanup, and source-delete failure. There is no
repository-configured coverage threshold or integration-test command.

## Change Guidelines

- Keep changes focused on the plugin or migration behavior being changed; do
  not include unrelated formatting changes.
- Update the corresponding root test when behavior changes. Update `README.md`
  for user-visible commands or installation changes, and update
  `CROSS_PROJECT_SESSION_MIGRATION.md` when the migration contract changes.
- Keep `package.json` and `bun.lock` consistent when dependencies change; do
  not edit dependency entries in the lockfile by hand.
- Do not edit `node_modules/` or `.DS_Store`; both are ignored. No other
  generated code, vendored code, migrations, snapshots, or schema outputs are
  present in the tracked repository.
- Preserve the migration safety boundary: never use a live session move as a
  validation shortcut. The real flow can import data and delete source
  sessions; use the mocked tests for failure-path validation.

## Validation Checklist

Run these from the repository root, from fastest targeted checks to broader
checks:

- [ ] Run the affected test file, such as `bun test session-migration.test.ts`.
- [ ] Run `bun run typecheck`.
- [ ] Run `bun test`.
- [ ] Run `git diff --check` and review `git diff` for focused changes.
- [ ] For TUI-facing changes, manually load the configured plugin in OpenCode;
      do not perform a real migration merely to validate the plugin.

## Important Constraints

- Cross-project migration requires a Bun runtime with `Bun.spawn` and an
  available OpenCode CLI. The optional `OPENCODE_BIN` variable selects that
  executable.
- The source session must be idle before and during migration. The migration
  deliberately does not transfer uncommitted project files, snapshots, or
  patch parts.
- A failed import should leave the source intact and clean up destination
  records. If source deletion cannot be confirmed, the new session is kept and
  the user is warned that both trees may remain.
- The only documented global runtime configuration is
  `~/.config/opencode/tui.json`; do not commit local paths, credentials, or
  other machine-specific configuration.
