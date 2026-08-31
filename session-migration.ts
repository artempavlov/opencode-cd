import { randomUUID } from "node:crypto"
import { access, chmod, constants, mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { TuiPluginApi } from "@opencode-ai/plugin/tui"

type Api = TuiPluginApi
type Client = Api["client"]
type SessionInfo = Record<string, any> & {
  id: string
  projectID: string
  directory: string
  title: string
  agent?: string
  model?: {
    id: string
    providerID: string
    variant?: string
  }
  parentID?: string
  permission?: unknown
  summary?: {
    additions: number
    deletions: number
    files: number
    diffs?: unknown[]
  }
  revert?: unknown
}

type SessionMessage = {
  info: Record<string, any> & { id: string }
  parts: Array<Record<string, any>>
}

export type ImportPayload = {
  info: Omit<SessionInfo, "projectID" | "directory"> & {
    projectID?: string
    directory?: string
  }
  messages: SessionMessage[]
}

export type MigrationProgress = (message: string) => void

export type MigrationResult = {
  sessionID: string
  sourceDeleted: boolean
  warnings: string[]
}

type ImportRunner = (input: { directory: string; filePath: string }) => Promise<void>

type DestinationSettings = {
  model?: SessionInfo["model"]
  agent?: string
  warnings: string[]
}

export function prepareImportPayload(
  source: SessionInfo,
  messages: SessionMessage[],
  destinationSessionID: string,
  settings: DestinationSettings,
): ImportPayload {
  const summary = source.summary
    ? {
        additions: source.summary.additions,
        deletions: source.summary.deletions,
        files: source.summary.files,
      }
    : undefined

  const info = {
    ...source,
    id: destinationSessionID,
    parentID: undefined,
    permission: undefined,
    workspaceID: undefined,
    share: undefined,
    projectID: undefined,
    directory: undefined,
    path: undefined,
    revert: undefined,
    summary,
    model: settings.model,
    agent: settings.agent,
  } as Omit<SessionInfo, "projectID" | "directory"> & { projectID?: string; directory?: string }

  const idNamespace = randomUUID().replaceAll("-", "")
  const messageIDs = new Map(messages.map((message) => [message.info.id, createID("msg", message.info.id, idNamespace)]))
  const importedMessages = messages.map((message) => {
    if (message.info.parentID && !messageIDs.has(message.info.parentID)) {
      throw new Error(`Message ${message.info.id} refers to a parent outside the transferred history`)
    }
    const id = messageIDs.get(message.info.id) ?? createID("msg", message.info.id, idNamespace)
    return {
      info: {
        ...message.info,
        id,
        sessionID: source.id,
        parentID: message.info.parentID ? messageIDs.get(message.info.parentID) : undefined,
      },
      parts: message.parts
        .filter(isTransferablePart)
        .map((part) => rewritePart(part, destinationSessionID, id, messageIDs, idNamespace)),
    }
  })

  return { info, messages: importedMessages }
}

export function sameMessageShape(expected: SessionMessage[], actual: SessionMessage[]) {
  if (actual.length !== expected.length) return false
  const expectedParents = new Map(expected.map((message, index) => [message.info.id, index]))
  const actualParents = new Map(actual.map((message, index) => [message.info.id, index]))
  return expected.every((message, index) => {
    const other = actual[index]
    if (!other) return false
    const expectedParts = message.parts.filter(isTransferablePart)
    const actualParts = other.parts.filter(isTransferablePart)
    if (actualParts.length !== expectedParts.length) return false
    if (comparableInfo(message.info) !== comparableInfo(other.info)) return false
    const expectedParent = message.info.parentID ? expectedParents.get(message.info.parentID) : undefined
    const actualParent = other.info.parentID ? actualParents.get(other.info.parentID) : undefined
    if (expectedParent !== actualParent) return false
    return expectedParts.every((part, partIndex) => comparablePart(part) === comparablePart(actualParts[partIndex]))
  })
}

function sameImportedMessageShape(expected: SessionMessage[], actual: SessionMessage[]) {
  if (actual.length !== expected.length) return false
  return expected.every((message, index) => {
    const other = actual[index]
    if (
      !other ||
      other.info.id !== message.info.id ||
      other.info.parentID !== message.info.parentID ||
      comparableInfo(other.info) !== comparableInfo(message.info)
    ) return false
    const expectedParts = message.parts.filter(isTransferablePart)
    const actualParts = other.parts.filter(isTransferablePart)
    if (actualParts.length !== expectedParts.length) return false
    return expectedParts.every((part, partIndex) => {
      const otherPart = actualParts[partIndex]
      return (
        otherPart.id === part.id &&
        otherPart.messageID === part.messageID &&
        otherPart.sessionID === part.sessionID &&
        sameNestedPartIdentity(part, otherPart) &&
        comparablePart(part) === comparablePart(otherPart)
      )
    })
  })
}

function sameNestedPartIdentity(expected: Record<string, any>, actual: Record<string, any>): boolean {
  if (expected.type === "compaction" && expected.tail_start_id !== actual.tail_start_id) return false
  if (expected.type !== "tool") return true
  const expectedAttachments = expected.state?.attachments
  const actualAttachments = actual.state?.attachments
  if (!Array.isArray(expectedAttachments) || !Array.isArray(actualAttachments)) return expectedAttachments === actualAttachments
  if (expectedAttachments.length !== actualAttachments.length) return false
  return expectedAttachments.every((attachment: Record<string, any>, index: number) => {
    const other = actualAttachments[index]
    return Boolean(other) &&
      other.id === attachment.id &&
      other.sessionID === attachment.sessionID &&
      other.messageID === attachment.messageID &&
      sameNestedPartIdentity(attachment, other)
  })
}

function isTransferablePart(part: Record<string, any>) {
  return part.type !== "snapshot" && part.type !== "patch"
}

function rewritePart(
  part: Record<string, any>,
  destinationSessionID: string,
  messageID: string,
  messageIDs: Map<string, string>,
  idNamespace: string,
) {
  const rewritten: Record<string, any> = {
    ...part,
    id: createID("prt", part.id, idNamespace),
    sessionID: destinationSessionID,
    messageID,
  }

  if (part.type === "compaction") {
    if (part.tail_start_id && !messageIDs.has(part.tail_start_id)) {
      throw new Error(`Compaction part ${part.id} refers to a message outside the transferred history`)
    }
    rewritten.tail_start_id = part.tail_start_id ? messageIDs.get(part.tail_start_id) : undefined
  }
  if (part.type === "step-start" || part.type === "step-finish") rewritten.snapshot = undefined
  if (part.type === "tool" && part.state && Array.isArray(part.state.attachments)) {
    rewritten.state = {
      ...part.state,
      attachments: part.state.attachments.map((attachment: Record<string, any>) =>
        rewritePart(attachment, destinationSessionID, messageID, messageIDs, idNamespace),
      ),
    }
  }

  return rewritten
}

export async function migrateSession(input: {
  api: Api
  sessionID: string
  sourceDirectory: string
  destinationDirectory: string
  destinationProjectID?: string
  importSession?: ImportRunner
  progress?: MigrationProgress
}): Promise<MigrationResult> {
  const { api, sessionID, sourceDirectory, destinationDirectory, progress } = input
  const client = api.client as any as Client & Record<string, any>
  let stage = "reading the source session"
  let destinationSessionID: string | undefined
  try {
    const source = await getSession(client, sessionID, sourceDirectory)
    stage = "checking child sessions"
    await ensureNoChildren(client, sessionID, sourceDirectory)
    stage = "checking source state"
    await ensureIdle(client, sessionID, sourceDirectory)
    stage = "reading the source history"
    const messages = await getMessages(client, sessionID, sourceDirectory)
    stage = "resolving destination settings"
    const settings = await destinationSettings(client, source, destinationDirectory)
    const destinationProjectID = input.destinationProjectID ?? (await getProjectID(client, destinationDirectory))

    stage = "creating the destination session"
    progress?.("Creating destination session")
    destinationSessionID = await createSessionID(client, destinationDirectory, settings)
    await deleteAndVerifySession(client, destinationSessionID, destinationDirectory)
    const payload = prepareImportPayload(source, messages, destinationSessionID, settings)

    stage = "preparing the export"
    progress?.("Preparing session export")
    await withExportFile(payload, async (filePath) => {
      stage = "importing session history"
      progress?.("Importing session history")
      await (input.importSession ?? runImport)({ directory: destinationDirectory, filePath })
    })

    stage = "verifying the imported session"
    progress?.("Verifying imported session")
    const imported = await getSession(client, destinationSessionID, destinationDirectory)
    const importedMessages = await getMessages(client, destinationSessionID, destinationDirectory)
    verifyImportedSession(
      imported,
      importedMessages,
      payload.messages,
      source,
      destinationSessionID,
      destinationDirectory,
      destinationProjectID,
      settings,
    )

    stage = "checking session continuation"
    progress?.("Checking continuation")
    const reminder = await addDirectoryReminder(client, destinationSessionID, destinationDirectory, settings)
    const continuedMessages = await getMessages(client, destinationSessionID, destinationDirectory)
    verifyReminder(continuedMessages, reminder, importedMessages)
    const continued = await getSession(client, destinationSessionID, destinationDirectory)
    verifyImportedSession(
      continued,
      importedMessages,
      payload.messages,
      source,
      destinationSessionID,
      destinationDirectory,
      destinationProjectID,
      settings,
    )

    stage = "removing the source session"
    progress?.("Removing source session")
    await ensureSourceStillSafe(client, sessionID, sourceDirectory, source, messages)
    let sourceDeleted = true
    const warnings = [...settings.warnings]
    try {
      await deleteSession(client, sessionID, sourceDirectory)
      const deletionState = await sessionDeletionState(client, sessionID, sourceDirectory)
      if (deletionState !== "gone") {
        sourceDeleted = false
        warnings.push(
          deletionState === "present"
            ? "The source session could not be removed; both sessions remain after an unconfirmed deletion."
            : "The source session deletion could not be verified; both sessions remain.",
        )
      }
    } catch (error) {
      sourceDeleted = false
      warnings.push(`The source session could not be removed; both sessions remain: ${errorMessage(error)}`)
    }

    return { sessionID: destinationSessionID, sourceDeleted, warnings }
  } catch (error) {
    if (destinationSessionID) {
      progress?.("Cleaning up partial destination")
      try {
        await deleteAndVerifySession(client, destinationSessionID, destinationDirectory)
      } catch (cleanupError) {
        throw new Error(
          `Session migration failed while ${stage}: ${errorMessage(error)}. Could not remove the partial destination session: ${errorMessage(cleanupError)}`,
        )
      }
    }
    throw new Error(`Session migration failed while ${stage}: ${errorMessage(error)}`)
  }
}

async function getSession(client: Client & Record<string, any>, sessionID: string, directory: string) {
  const result = await client.session.get({ sessionID, directory }, { throwOnError: true })
  const info = result?.data
  if (!info?.id) throw new Error(`Session ${sessionID} was not returned by OpenCode`)
  return info as SessionInfo
}

async function getMessages(client: Client & Record<string, any>, sessionID: string, directory: string) {
  const result = await client.session.messages({ sessionID, directory }, { throwOnError: true })
  const messages = result?.data
  if (!Array.isArray(messages)) throw new Error(`Could not read messages for session ${sessionID}`)
  return messages as SessionMessage[]
}

async function ensureNoChildren(client: Client & Record<string, any>, sessionID: string, directory: string) {
  const children = client.session?.children
  if (typeof children !== "function") throw new Error("OpenCode cannot verify child sessions before migration")
  const result = await children.call(client.session, { sessionID, directory }, { throwOnError: true })
  if (!Array.isArray(result?.data)) throw new Error("OpenCode returned an invalid child-session list")
  if (result.data.length > 0) {
    throw new Error("This session has child sessions; move the child sessions first to avoid deleting them")
  }
}

async function ensureSourceStillSafe(
  client: Client & Record<string, any>,
  sessionID: string,
  directory: string,
  source: SessionInfo,
  sourceMessages: SessionMessage[],
) {
  await ensureIdle(client, sessionID, directory)
  await ensureNoChildren(client, sessionID, directory)
  const current = await getSession(client, sessionID, directory)
  const currentMessages = await getMessages(client, sessionID, directory)
  if (
    current.title !== source.title ||
    stableStringify(current.metadata) !== stableStringify(source.metadata) ||
    current.agent !== source.agent ||
    current.projectID !== source.projectID ||
    current.directory !== source.directory ||
    current.parentID !== source.parentID ||
    stableStringify(current.permission) !== stableStringify(source.permission) ||
    stableStringify(current.model) !== stableStringify(source.model)
  ) {
    throw new Error("The source session changed during migration")
  }
  if (!sameMessageShape(sourceMessages, currentMessages)) throw new Error("The source history changed during migration")
}

async function ensureIdle(client: Client & Record<string, any>, sessionID: string, directory: string) {
  const status = client.session?.status
  if (typeof status !== "function") return
  const result = await status.call(client.session, { directory }, { throwOnError: true })
  const current = result?.data?.[sessionID]
  if (current && current.type !== "idle") throw new Error("The source session became busy during migration")
}

async function getProjectID(client: Client & Record<string, any>, directory: string) {
  const current = client.project?.current
  if (typeof current !== "function") return undefined
  const result = await current.call(client.project, { directory }, { throwOnError: true })
  return result?.data?.id as string | undefined
}

async function destinationSettings(client: Client & Record<string, any>, source: SessionInfo, directory: string) {
  const warnings: string[] = []
  const sourceModel = source.model
  let model = sourceModel
  if (sourceModel) {
    const modelsResult = await client.v2.model.list({ location: { directory } }, { throwOnError: true })
    const models = modelsResult?.data?.data
    if (!Array.isArray(models)) throw new Error("Could not list models for the destination project")
    const exact = models.find(
      (item: any) => item.enabled !== false && item.id === sourceModel.id && item.providerID === sourceModel.providerID,
    )
    if (exact) {
      const variant = sourceModel.variant && exact.variants?.some((item: any) => item.id === sourceModel.variant)
        ? sourceModel.variant
        : undefined
      model = { id: exact.id, providerID: exact.providerID, variant }
      if (sourceModel.variant && !variant) {
        warnings.push(`Model variant ${sourceModel.variant} is unavailable; using the base ${exact.providerID}/${exact.id} model.`)
      }
    } else {
      const fallback = models.find((item: any) => item.enabled !== false)
      if (!fallback) throw new Error("No enabled model is available in the destination project")
      model = { id: fallback.id, providerID: fallback.providerID }
      warnings.push(`Model ${sourceModel.providerID}/${sourceModel.id} is unavailable; selected ${fallback.providerID}/${fallback.id}.`)
    }
  }

  let agent = source.agent
  if (source.agent) {
    const agentsResult = await client.app.agents({ directory }, { throwOnError: true })
    const agents = agentsResult?.data
    if (!Array.isArray(agents)) throw new Error("Could not list agents for the destination project")
    const exact = agents.find((item: any) => item.name === source.agent && item.hidden !== true)
    if (exact) {
      agent = exact.name
    } else {
      const fallback =
        agents.find((item: any) => (item.mode === "primary" || item.mode === "all") && item.hidden !== true) ??
        agents.find((item: any) => item.hidden !== true)
      if (!fallback) throw new Error("No visible agent is available in the destination project")
      agent = fallback.name
      warnings.push(`Agent ${source.agent} is unavailable; selected ${fallback.name}.`)
    }
  }

  return { model, agent, warnings }
}

async function createSessionID(client: Client & Record<string, any>, directory: string, settings: DestinationSettings) {
  const create = client.v2?.session?.create
  if (typeof create !== "function") throw new Error("OpenCode 1.18+ is required for cross-project migration")
  const result = await create.call(
    client.v2.session,
    {
      agent: settings.agent,
      model: settings.model,
      location: { directory },
    },
    { throwOnError: true },
  )
  const id = result?.data?.data?.id
  if (!id) throw new Error("OpenCode did not return a destination session ID")
  return id
}

function verifyImportedSession(
  imported: SessionInfo,
  importedMessages: SessionMessage[],
  sourceMessages: SessionMessage[],
  source: SessionInfo,
  destinationSessionID: string,
  directory: string,
  projectID: string | undefined,
  settings: DestinationSettings,
) {
  if (imported.id !== destinationSessionID) throw new Error("Imported session ID does not match the destination")
  if (imported.directory !== directory) throw new Error("Imported session directory does not match the destination")
  if (projectID && imported.projectID !== projectID) throw new Error("Imported session project does not match the destination")
  if (imported.title !== source.title) throw new Error("Imported session title does not match the source")
  if (stableStringify(imported.metadata) !== stableStringify(source.metadata)) throw new Error("Imported session metadata does not match the source")
  if (imported.parentID !== undefined) throw new Error("Imported session still refers to a source parent session")
  if (imported.permission !== undefined) throw new Error("Source session permission rules leaked into the destination")
  if (!sameImportedMessageShape(sourceMessages, importedMessages)) throw new Error("Imported session history does not match the source")
  if (settings.agent && imported.agent !== settings.agent) throw new Error("Imported session agent does not match the selected agent")
  if (
    settings.model &&
    (imported.model?.id !== settings.model.id ||
      imported.model.providerID !== settings.model.providerID ||
      imported.model.variant !== settings.model.variant)
  ) {
    throw new Error("Imported session model does not match the selected model")
  }
}

async function addDirectoryReminder(
  client: Client & Record<string, any>,
  sessionID: string,
  directory: string,
  settings: DestinationSettings,
) {
  const prompt = client.session?.prompt
  if (typeof prompt !== "function") throw new Error("OpenCode cannot verify session continuation")
  const text = `The user moved this session to "${directory}". Use it as the working directory for subsequent operations.`
  const result = await prompt.call(
    client.session,
    {
      sessionID,
      directory,
      noReply: true,
      agent: settings.agent,
      model: settings.model
        ? { providerID: settings.model.providerID, modelID: settings.model.id }
        : undefined,
      variant: settings.model?.variant,
      parts: [
        {
          type: "text",
          text,
          synthetic: true,
        },
      ],
    },
    { throwOnError: true },
  )
  const response = result?.data as { info?: { id?: string }; id?: string } | undefined
  const messageID = response?.info?.id ?? response?.id
  if (!messageID) throw new Error("OpenCode did not return the continuation reminder")
  return { text, messageID: messageID as string }
}

function verifyReminder(messages: SessionMessage[], reminder: { text: string; messageID: string }, previous: SessionMessage[]) {
  if (messages.length !== previous.length + 1) throw new Error("The destination session did not accept the continuation reminder")
  const reminderIndex = messages.findIndex(
    (message) =>
      message.info.id === reminder.messageID &&
      message.parts.some((part) => part.type === "text" && part.synthetic === true && part.text === reminder.text),
  )
  if (reminderIndex < 0) throw new Error("The destination session did not persist the continuation reminder")
  const historical = messages.filter((_, index) => index !== reminderIndex)
  if (!sameImportedMessageShape(previous, historical)) throw new Error("The destination history changed while checking continuation")
}

async function deleteSession(client: Client & Record<string, any>, sessionID: string, directory: string) {
  await client.session.delete({ sessionID, directory }, { throwOnError: true })
}

async function deleteAndVerifySession(client: Client & Record<string, any>, sessionID: string, directory: string) {
  await deleteSession(client, sessionID, directory)
  const state = await sessionDeletionState(client, sessionID, directory)
  if (state !== "gone") throw new Error(`Destination session deletion is ${state}`)
}

async function sessionDeletionState(client: Client & Record<string, any>, sessionID: string, directory: string) {
  try {
    const result = await client.session.get({ sessionID, directory }, { throwOnError: true })
    return result?.data?.id ? "present" : "unknown"
  } catch (error) {
    return isNotFound(error) ? "gone" : "unknown"
  }
}

async function withExportFile<T>(payload: ImportPayload, callback: (filePath: string) => Promise<T>) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "opencode-cd-"))
  const filePath = path.join(directory, "session.json")
  try {
    await writeFile(filePath, JSON.stringify(payload), { encoding: "utf8", mode: 0o600 })
    await chmod(filePath, 0o600)
    return await callback(filePath)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

async function runImport(input: { directory: string; filePath: string }) {
  const bun = (globalThis as any).Bun
  if (!bun?.spawn) throw new Error("Bun runtime is required for session import")
  const child = bun.spawn([process.env.OPENCODE_BIN ?? "opencode", "import", input.filePath], {
    cwd: input.directory,
    stdout: "pipe",
    stderr: "pipe",
  })
  const stdoutPromise = child.stdout ? new Response(child.stdout).text() : Promise.resolve("")
  const stderrPromise = child.stderr ? new Response(child.stderr).text() : Promise.resolve("")
  const [stdout, stderr, code] = await Promise.all([stdoutPromise, stderrPromise, child.exited])
  if (code !== 0) throw new Error(stderr.trim() || stdout.trim() || `opencode import exited with code ${code}`)
}

function errorMessage(error: unknown) {
  if (error instanceof Error) return error.message
  if (typeof error === "string") return error
  if (error && typeof error === "object") {
    const value = error as { data?: { message?: unknown }; message?: unknown }
    if (typeof value.data?.message === "string") return value.data.message
    if (typeof value.message === "string") return value.message
  }
  return String(error)
}

function createID(prefix: string, originalID: string, namespace: string) {
  return `${prefix}_${namespace}_${originalID}`
}

function comparableInfo(info: Record<string, any>) {
  const value = { ...info }
  delete value.id
  delete value.sessionID
  delete value.parentID
  return stableStringify(value)
}

function comparablePart(part: Record<string, any>) {
  return stableStringify(stripPartIdentity(part))
}

function stripPartIdentity(part: Record<string, any>): Record<string, any> {
  const value = { ...part }
  delete value.id
  delete value.sessionID
  delete value.messageID
  if (value.type === "compaction") delete value.tail_start_id
  if (value.type === "step-start" || value.type === "step-finish") delete value.snapshot
  if (value.type === "tool" && value.state && Array.isArray(value.state.attachments)) {
    value.state = {
      ...value.state,
      attachments: value.state.attachments.map((attachment: Record<string, any>) => stripPartIdentity(attachment)),
    }
  }
  return value
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`
  if (!value || typeof value !== "object") return JSON.stringify(value) ?? String(value)
  const entries = Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
  return `{${entries.join(",")}}`
}

function isNotFound(error: unknown) {
  if (!error || typeof error !== "object") return false
  const value = error as {
    name?: unknown
    status?: unknown
    statusCode?: unknown
    response?: { status?: unknown }
    message?: unknown
    data?: { name?: unknown; status?: unknown; statusCode?: unknown; _tag?: unknown }
  }
  const status = value.status ?? value.statusCode ?? value.response?.status ?? value.data?.status ?? value.data?.statusCode
  if (status === 404) return true
  const names = [value.name, value.message, value.data?.name, value.data?._tag]
  return names.some((name) => typeof name === "string" && /not.?found/i.test(name))
}
