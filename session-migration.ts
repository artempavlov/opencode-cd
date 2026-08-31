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
  destinationParentID?: string,
  sessionIDs?: Map<string, string>,
): ImportPayload {
  const summary = source.summary
    ? {
        additions: source.summary.additions,
        deletions: source.summary.deletions,
        files: source.summary.files,
      }
    : undefined

  const info = rewriteSessionReferences({
    ...source,
    id: destinationSessionID,
    parentID: destinationParentID,
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
  }, sessionIDs) as Omit<SessionInfo, "projectID" | "directory"> & { projectID?: string; directory?: string }

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
        .map((part) => rewritePart(part, destinationSessionID, id, messageIDs, idNamespace, sessionIDs)),
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
  sessionIDs?: Map<string, string>,
) {
  const rewritten: Record<string, any> = {
    ...rewriteSessionReferences(part, sessionIDs),
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
        rewritePart(attachment, destinationSessionID, messageID, messageIDs, idNamespace, sessionIDs),
      ),
    }
  }

  return rewritten
}

function rewriteSessionReferences(value: Record<string, any>, sessionIDs?: Map<string, string>): Record<string, any> {
  if (!sessionIDs) return { ...value }
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => {
      if (
        (key === "sessionID" ||
          key === "sessionId" ||
          key === "parentSessionID" ||
          key === "parentSessionId" ||
          key === "jobID" ||
          key === "jobId") &&
        typeof item === "string"
      ) {
        return [key, sessionIDs.get(item) ?? item]
      }
      if (Array.isArray(item)) return [key, item.map((entry) => rewriteReferenceValue(entry, sessionIDs))]
      if (item && typeof item === "object") return [key, rewriteReferenceValue(item, sessionIDs)]
      return [key, item]
    }),
  )
}

function rewriteReferenceValue(value: unknown, sessionIDs: Map<string, string>): unknown {
  if (Array.isArray(value)) return value.map((entry) => rewriteReferenceValue(entry, sessionIDs))
  if (!value || typeof value !== "object") return value
  return rewriteSessionReferences(value as Record<string, any>, sessionIDs)
}

export async function migrateSession(input: {
  api: Api
  sessionID: string
  sourceDirectory: string
  destinationDirectory: string
  destinationProjectID?: string
  newSessionID?: () => string
  importSession?: ImportRunner
  progress?: MigrationProgress
}): Promise<MigrationResult> {
  const { api, sessionID, sourceDirectory, destinationDirectory, progress } = input
  const client = api.client as any as Client & Record<string, any>
  let stage = "discovering the source session tree"
  const destinationNodes: PreparedNode[] = []
  try {
    const sourceTree = await discoverSessionTree(client, sessionID, sourceDirectory)
    const sourceNodes = flattenNodes(sourceTree)
    stage = "checking source state"
    for (const node of sourceNodes) await ensureIdle(client, node.info.id, sourceDirectory)

    stage = "reading the source history"
    for (const node of sourceNodes) node.messages = await getMessages(client, node.info.id, sourceDirectory)

    stage = "resolving destination settings"
    for (const node of sourceNodes) node.settings = await destinationSettings(client, node.info, destinationDirectory)
    const destinationProjectID = input.destinationProjectID ?? (await getProjectID(client, destinationDirectory))

    stage = "creating the destination sessions"
    progress?.(`Creating ${sourceNodes.length} destination session${sourceNodes.length === 1 ? "" : "s"}`)
    const destinationIDs = new Map<string, string>()
    for (const node of sourceNodes) {
      const destinationID = (input.newSessionID ?? createDestinationSessionID)()
      destinationIDs.set(node.info.id, destinationID)
      const destinationNode: PreparedNode = {
        source: node,
        destinationID,
        destinationParentID: node === sourceTree ? undefined : destinationIDs.get(node.info.parentID ?? ""),
        settings: node.settings!,
      }
      destinationNodes.push(destinationNode)
      await createSessionID(client, destinationDirectory, destinationNode.settings, destinationID)
      await deleteAndVerifySession(client, destinationID, destinationDirectory)
    }

    for (const node of destinationNodes) {
      if (node.source !== sourceTree && !node.destinationParentID) {
        throw new Error(`Could not map the parent session for ${node.source.info.id}`)
      }
      node.payload = prepareImportPayload(
        node.source.info,
        node.source.messages,
        node.destinationID,
        node.settings,
        node.destinationParentID,
        destinationIDs,
      )
    }

    stage = "importing session history"
    for (const [index, node] of destinationNodes.entries()) {
      progress?.(`Importing session history (${index + 1}/${destinationNodes.length})`)
      await withExportFile(node.payload!, async (filePath) => {
        await (input.importSession ?? runImport)({ directory: destinationDirectory, filePath })
      })
    }

    stage = "verifying the imported sessions"
    for (const [index, node] of destinationNodes.entries()) {
      progress?.(`Verifying imported session (${index + 1}/${destinationNodes.length})`)
      const imported = await getSession(client, node.destinationID, destinationDirectory)
      const importedMessages = await getMessages(client, node.destinationID, destinationDirectory)
      verifyImportedSession(
        imported,
        importedMessages,
        node.payload!.messages,
        node.source.info,
        node.payload!.info,
        node.destinationID,
        node.destinationParentID,
        destinationDirectory,
        destinationProjectID,
        node.settings,
      )
      node.importedMessages = importedMessages
    }

    stage = "checking session continuation"
    for (const [index, node] of destinationNodes.entries()) {
      progress?.(`Checking continuation (${index + 1}/${destinationNodes.length})`)
      const reminder = await addDirectoryReminder(client, node.destinationID, destinationDirectory, node.settings)
      const continuedMessages = await getMessages(client, node.destinationID, destinationDirectory)
      verifyReminder(continuedMessages, reminder, node.importedMessages!)
      const continued = await getSession(client, node.destinationID, destinationDirectory)
      verifyImportedSession(
        continued,
        node.importedMessages!,
        node.payload!.messages,
        node.source.info,
        node.payload!.info,
        node.destinationID,
        node.destinationParentID,
        destinationDirectory,
        destinationProjectID,
        node.settings,
      )
    }

    stage = "removing the source sessions"
    progress?.("Removing source sessions")
    await ensureSourceStillSafe(client, sourceNodes, sourceDirectory)
    const warnings = destinationNodes.flatMap((node) => node.settings.warnings)
    let sourceDeleted = true
    const sourceRoot = sourceNodes[0]!
    try {
      await deleteSession(client, sourceRoot.info.id, sourceDirectory)
      const deletionStates = await Promise.all(
        sourceNodes.map(async (node) => ({ node, state: await sessionDeletionState(client, node.info.id, sourceDirectory) })),
      )
      const remaining = deletionStates.filter((item) => item.state !== "gone")
      if (remaining.length > 0) {
        sourceDeleted = false
        warnings.push("The source session tree could not be fully removed; both session trees remain after an unconfirmed deletion.")
      }
    } catch (error) {
      sourceDeleted = false
      warnings.push(`The source session tree could not be removed; both session trees remain: ${errorMessage(error)}`)
    }

    return { sessionID: destinationNodes[0]!.destinationID, sourceDeleted, warnings }
  } catch (error) {
    if (destinationNodes.length > 0) {
      progress?.("Cleaning up partial destination")
      try {
        await cleanupDestinationSessions(client, destinationNodes, destinationDirectory)
      } catch (cleanupError) {
        throw new Error(
          `Session migration failed while ${stage}: ${errorMessage(error)}. Could not remove the partial destination session: ${errorMessage(cleanupError)}`,
        )
      }
    }
    throw new Error(`Session migration failed while ${stage}: ${errorMessage(error)}`)
  }
}

type SessionNode = {
  info: SessionInfo
  messages: SessionMessage[]
  children: SessionNode[]
  depth: number
  settings?: DestinationSettings
}

type PreparedNode = {
  source: SessionNode
  destinationID: string
  destinationParentID?: string
  settings: DestinationSettings
  payload?: ImportPayload
  importedMessages?: SessionMessage[]
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

async function getChildren(client: Client & Record<string, any>, sessionID: string, directory: string) {
  const children = client.session?.children
  if (typeof children !== "function") throw new Error("OpenCode cannot verify child sessions before migration")
  const result = await children.call(client.session, { sessionID, directory }, { throwOnError: true })
  if (!Array.isArray(result?.data)) throw new Error("OpenCode returned an invalid child-session list")
  return result.data as SessionInfo[]
}

async function discoverSessionTree(client: Client & Record<string, any>, sessionID: string, directory: string) {
  const visited = new Set<string>()
  const visit = async (id: string, depth: number, expectedParentID?: string, projectID?: string): Promise<SessionNode> => {
    if (visited.has(id)) throw new Error(`Session tree contains a cycle at ${id}`)
    visited.add(id)
    const info = await getSession(client, id, directory)
    if (expectedParentID && info.parentID !== expectedParentID) {
      throw new Error(`Child session ${id} does not refer to its reported parent`)
    }
    if (projectID && info.projectID !== projectID) {
      throw new Error(`Child session ${id} belongs to another project`)
    }
    const rootProjectID = projectID ?? info.projectID
    const node: SessionNode = { info, messages: [], children: [], depth }
    for (const child of await getChildren(client, id, directory)) {
      if (!child.id) throw new Error(`OpenCode returned a child session without an ID for ${id}`)
      node.children.push(await visit(child.id, depth + 1, id, rootProjectID))
    }
    return node
  }
  return visit(sessionID, 0)
}

function flattenNodes(root: SessionNode) {
  const result: SessionNode[] = [root]
  for (const child of root.children) result.push(...flattenNodes(child))
  return result
}

async function ensureSourceStillSafe(
  client: Client & Record<string, any>,
  sourceNodes: SessionNode[],
  directory: string,
) {
  for (const node of sourceNodes) {
    await ensureIdle(client, node.info.id, directory)
    const current = await getSession(client, node.info.id, directory)
    if (
      current.title !== node.info.title ||
      stableStringify(current.metadata) !== stableStringify(node.info.metadata) ||
      current.agent !== node.info.agent ||
      current.projectID !== node.info.projectID ||
      current.directory !== node.info.directory ||
      current.parentID !== node.info.parentID ||
      stableStringify(current.permission) !== stableStringify(node.info.permission) ||
      stableStringify(current.model) !== stableStringify(node.info.model)
    ) {
      throw new Error(`The source session ${node.info.id} changed during migration`)
    }
    const currentChildren = await getChildren(client, node.info.id, directory)
    const expectedChildren = node.children.map((child) => child.info.id)
    const actualChildren = currentChildren.map((child) => child.id)
    if (stableStringify(actualChildren) !== stableStringify(expectedChildren)) {
      throw new Error(`The child sessions of ${node.info.id} changed during migration`)
    }
    const currentMessages = await getMessages(client, node.info.id, directory)
    if (!sameMessageShape(node.messages, currentMessages)) throw new Error(`The history of ${node.info.id} changed during migration`)
  }
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

async function createSessionID(
  client: Client & Record<string, any>,
  directory: string,
  settings: DestinationSettings,
  requestedID: string,
) {
  const create = client.v2?.session?.create
  if (typeof create !== "function") throw new Error("OpenCode 1.18+ is required for cross-project migration")
  const result = await create.call(
    client.v2.session,
    {
      id: requestedID,
      agent: settings.agent,
      model: settings.model,
      location: { directory },
    },
    { throwOnError: true },
  )
  const id = result?.data?.data?.id
  if (!id || id !== requestedID) throw new Error("OpenCode did not create the requested destination session ID")
  return id
}

function verifyImportedSession(
  imported: SessionInfo,
      importedMessages: SessionMessage[],
      sourceMessages: SessionMessage[],
      source: SessionInfo,
  expectedInfo: ImportPayload["info"],
  destinationSessionID: string,
  destinationParentID: string | undefined,
  directory: string,
  projectID: string | undefined,
  settings: DestinationSettings,
) {
  if (imported.id !== destinationSessionID) throw new Error("Imported session ID does not match the destination")
  if (imported.directory !== directory) throw new Error("Imported session directory does not match the destination")
  if (projectID && imported.projectID !== projectID) throw new Error("Imported session project does not match the destination")
  if (imported.title !== source.title) throw new Error("Imported session title does not match the source")
  if (stableStringify(imported.metadata) !== stableStringify(expectedInfo.metadata)) throw new Error("Imported session metadata does not match the source")
  if (imported.parentID !== destinationParentID) throw new Error("Imported session parent does not match the destination tree")
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

async function cleanupDestinationSessions(client: Client & Record<string, any>, nodes: PreparedNode[], directory: string) {
  const failures: string[] = []
  for (const node of [...nodes].sort((left, right) => right.source.depth - left.source.depth)) {
    try {
      await deleteAndVerifySession(client, node.destinationID, directory)
    } catch (error) {
      failures.push(`${node.destinationID}: ${errorMessage(error)}`)
    }
  }
  if (failures.length > 0) throw new Error(failures.join("; "))
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

function createDestinationSessionID() {
  return `ses_${randomUUID().replaceAll("-", "")}`
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
