import { constants } from "node:fs"
import { access, stat } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { TuiPlugin, TuiPluginApi, TuiPluginModule } from "@opencode-ai/plugin/tui"
import { migrateSession } from "./session-migration.js"

const pluginID = "artem.session-directory"
const commandName = "session.change_directory"
const activeMoves = new Set<string>()

function currentSessionID(api: TuiPluginApi) {
  const route = api.route.current
  if (route.name !== "session") return
  const sessionID = route.params?.sessionID
  return typeof sessionID === "string" ? sessionID : undefined
}

function expandHome(value: string) {
  if (value === "~") return os.homedir()
  if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2))
  return value
}

export function resolveDirectory(value: string, current: string) {
  return path.resolve(current, expandHome(value.trim()))
}

export function isSessionIdle(status: { type: string } | undefined) {
  return !status || status.type === "idle"
}

export function shouldUseNativeMove(sourceProjectID: string, destinationProjectID: string) {
  return sourceProjectID === destinationProjectID
}

function message(error: unknown) {
  if (error instanceof Error) return error.message
  if (typeof error === "string") return error
  if (error && typeof error === "object") {
    const value = error as { data?: { message?: unknown }; message?: unknown }
    if (typeof value.data?.message === "string") return value.data.message
    if (typeof value.message === "string") return value.message
  }
  return String(error)
}

async function isDirectory(directory: string) {
  try {
    await access(directory, constants.R_OK | constants.X_OK)
    return (await stat(directory)).isDirectory()
  } catch {
    return false
  }
}

async function changedFiles(api: TuiPluginApi, directory: string) {
  try {
    const result = await (api.client as any).vcs.status({ directory })
    if (Array.isArray(result?.data)) return result.data
    if (Array.isArray(result)) return result
  } catch {
    // A non-Git directory has no changes to transfer.
  }
  return []
}

async function moveSession(api: TuiPluginApi, sessionID: string, directory: string, moveChanges: boolean) {
  const client = api.client as any
  const controlPlane = client.controlPlane ?? client.experimental?.controlPlane
  const move = controlPlane?.moveSession
  if (typeof move !== "function") {
    throw new Error("Session moving requires OpenCode 1.18.0 or newer")
  }

  await move.call(
    controlPlane,
    {
      sessionID,
      destination: { directory },
      moveChanges,
    },
    { throwOnError: true },
  )

  const promptAsync = client.session?.promptAsync
  if (typeof promptAsync !== "function") return

  await promptAsync
    .call(
      client.session,
      {
        sessionID,
        directory,
        noReply: true,
        parts: [
          {
            type: "text",
            text: `The user changed this session's working directory to "${directory}". Use it for all subsequent file operations.`,
            synthetic: true,
          },
        ],
      },
      { throwOnError: true },
    )
    .catch(() => {
      api.ui.toast({ variant: "warning", message: "Session moved, but the directory reminder could not be saved." })
    })
}

async function ensureIdle(api: TuiPluginApi, sessionID: string, directory: string) {
  const known = api.state.session.status(sessionID)
  if (known) {
    if (!isSessionIdle(known)) throw new Error("The session must be idle before it can be moved")
    return
  }

  const result = await (api.client as any).session.status({ directory }, { throwOnError: true })
  const status = result?.data?.[sessionID]
  if (!isSessionIdle(status)) throw new Error("The session must be idle before it can be moved")
}

async function sessionInfo(api: TuiPluginApi, sessionID: string, directory: string) {
  const result = await (api.client as any).session.get({ sessionID, directory }, { throwOnError: true })
  const info = result?.data
  if (!info?.id) throw new Error(`Session ${sessionID} was not found`)
  return info
}

async function projectInfo(api: TuiPluginApi, directory: string) {
  const result = await (api.client as any).project.current({ directory }, { throwOnError: true })
  const info = result?.data
  if (!info?.id) throw new Error(`Could not resolve the project for ${directory}`)
  return info
}

function openPathPrompt(api: TuiPluginApi) {
  const sessionID = currentSessionID(api)
  if (!sessionID) {
    api.ui.toast({
      variant: "warning",
      message: "Open a session before changing its directory.",
    })
    return
  }

  const session = api.state.session.get(sessionID)
  const current = session?.directory ?? api.state.path.directory
  if (!current) {
    api.ui.toast({ variant: "error", message: "The current session directory is not available yet." })
    return
  }

  api.ui.dialog.setSize("medium")
  api.ui.dialog.replace(() =>
    api.ui.DialogPrompt({
      title: "Change session directory",
      placeholder: "Absolute path or path relative to the current directory",
      onConfirm: (raw) => {
        if (!raw.trim()) {
          api.ui.toast({ variant: "error", message: "Directory path is required." })
          return
        }

        const directory = resolveDirectory(raw, current)
        void prepareMove(api, sessionID, current, directory)
      },
      onCancel: () => api.ui.dialog.clear(),
    }),
  )
}

async function prepareMove(api: TuiPluginApi, sessionID: string, current: string, directory: string) {
  if (!(await isDirectory(directory))) {
    api.ui.toast({ variant: "error", message: `Directory does not exist: ${directory}` })
    return
  }

  if (directory === path.resolve(current)) {
    api.ui.toast({ variant: "info", message: "The session is already using this directory." })
    return
  }

  const files = await changedFiles(api, current)
  const changes = files.length > 0
    ? `${files.length} changed file${files.length === 1 ? "" : "s"} will remain in the current directory. `
    : ""
  api.ui.dialog.replace(() =>
    api.ui.DialogConfirm({
      title: "Confirm session move",
      message: `${changes}The conversation will be verified before this move is finalized. Continue?`,
      onConfirm: () => {
        api.ui.dialog.clear()
        void performMove(api, sessionID, current, directory)
      },
      onCancel: () => api.ui.dialog.clear(),
    }),
  )
}

async function performMove(api: TuiPluginApi, sessionID: string, sourceDirectory: string, destinationDirectory: string) {
  if (activeMoves.has(sessionID)) {
    api.ui.toast({ variant: "warning", message: "A directory move is already in progress for this session." })
    return
  }

  activeMoves.add(sessionID)
  try {
    await ensureIdle(api, sessionID, sourceDirectory)
    const source = await sessionInfo(api, sessionID, sourceDirectory)
    const destination = await projectInfo(api, destinationDirectory)

    if (shouldUseNativeMove(source.projectID, destination.id)) {
      await moveSession(api, sessionID, destinationDirectory, false)
      api.ui.toast({ variant: "success", message: `Session directory changed to ${destinationDirectory}` })
      return
    }

    api.ui.toast({ variant: "info", message: "Moving session to another project..." })
    const result = await migrateSession({
      api,
      sessionID,
      sourceDirectory,
      destinationDirectory,
      destinationProjectID: destination.id,
      progress: (message: string) => api.ui.toast({ variant: "info", message }),
    })
    api.route.navigate("session", { sessionID: result.sessionID })
    if (result.warnings.length > 0) {
      api.ui.toast({ variant: "warning", message: result.warnings.join(" ") })
    }
    api.ui.toast({ variant: "success", message: `Session moved to ${destinationDirectory}` })
  } catch (error) {
    api.ui.toast({ variant: "error", message: `Could not change session directory: ${message(error)}` })
  } finally {
    activeMoves.delete(sessionID)
  }
}

const tui: TuiPlugin = async (api) => {
  api.keymap.registerLayer({
    commands: [
      {
        name: commandName,
        title: "Change session directory",
        desc: "Change the working directory of the current session",
        category: "Session",
        namespace: "palette",
        slashName: "session-cd",
        slashAliases: ["cd-session"],
        run: () => {
          setTimeout(() => openPathPrompt(api), 0)
        },
      },
    ],
    bindings: [{ key: "ctrl+shift+d", cmd: commandName, desc: "Change session directory" }],
  })
}

const plugin: TuiPluginModule & { id: string } = {
  id: pluginID,
  tui,
}

export default plugin
