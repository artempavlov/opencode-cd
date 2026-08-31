import { describe, expect, it } from "bun:test"
import { migrateSession, prepareImportPayload, sameMessageShape } from "./session-migration"

const sourceInfo = {
  id: "ses-source",
  projectID: "project-a",
  directory: "/projects/a",
  title: "Migration test",
  agent: "build",
  model: { id: "model-a", providerID: "provider-a", variant: "fast" },
  permission: [{ permission: "edit", pattern: "*", action: "allow" }],
  parentID: "ses-parent",
  summary: { additions: 1, deletions: 2, files: 1, diffs: [{ patch: "old" }] },
  revert: { messageID: "msg-1" },
  metadata: { ticket: "CD-1" },
}

const sourceMessages = [
  {
    info: { id: "msg-1", sessionID: "ses-source", role: "user" },
    parts: [{ id: "part-1", sessionID: "ses-source", messageID: "msg-1", type: "text", text: "Hello" }],
  },
]

function migrationApi(options: {
  failSourceDelete?: boolean
  models?: unknown[]
  agents?: unknown[]
  children?: unknown[]
  status?: { type: string }
  destinationProjectID?: string
}) {
  const deleted: string[] = []
  const deletedSet = new Set<string>()
  let imported = false
  let destinationMessages: unknown[] = []
  const destinationInfo = {
    ...sourceInfo,
    id: "ses-destination",
    projectID: "project-b",
    directory: "/projects/b",
    model: { id: "model-a", providerID: "provider-a" },
    permission: undefined,
    parentID: undefined,
    revert: undefined,
  }

  const client = {
    session: {
      async children() {
        return { data: options.children ?? [] }
      },
      async status() {
        return { data: { "ses-source": options.status ?? { type: "idle" } } }
      },
      async get(input: { sessionID: string }) {
        if (deletedSet.has(input.sessionID) && !(input.sessionID === "ses-destination" && imported)) throw new Error("not found")
        return { data: input.sessionID === "ses-source" || !imported ? sourceInfo : destinationInfo }
      },
      async messages(input: { sessionID: string }) {
        return { data: input.sessionID === "ses-source" || !imported ? sourceMessages : destinationMessages }
      },
      async delete(input: { sessionID: string }) {
        deleted.push(input.sessionID)
        if (options.failSourceDelete && input.sessionID === "ses-source") throw new Error("source delete failed")
        deletedSet.add(input.sessionID)
        return { data: true }
      },
      async prompt(input: { parts: Array<{ text: string; type: string; synthetic?: boolean }> }) {
        const parts = input.parts.map((part) => ({
          ...part,
          id: "part-reminder",
          sessionID: "ses-destination",
          messageID: "msg-reminder",
        }))
        destinationMessages = [
          ...destinationMessages,
          {
            info: { id: "msg-reminder", sessionID: "ses-destination", role: "user" },
            parts,
          },
        ]
        return { data: { info: { id: "msg-reminder" }, parts } }
      },
    },
    app: {
      async agents() {
        return { data: options.agents ?? [{ name: "build", mode: "primary", hidden: false }] }
      },
    },
    v2: {
      model: {
        async list() {
          return {
            data: {
              data: options.models ?? [
                {
                  id: "model-a",
                  providerID: "provider-a",
                  enabled: true,
                  variants: [{ id: "fast" }],
                },
              ],
            },
          }
        },
      },
      session: {
        async create() {
          return { data: { data: { id: "ses-destination" } } }
        },
      },
    },
  }

  return {
    api: { client } as any,
    deleted,
    markImported(messages: unknown[] = sourceMessages, info?: Record<string, unknown>) {
      imported = true
      destinationMessages = messages
      if (info?.model) destinationInfo.model = info.model
      if (info?.agent) destinationInfo.agent = info.agent as string
      if (options.destinationProjectID) destinationInfo.projectID = options.destinationProjectID
    },
  }
}

describe("session migration", () => {
  it("removes source-only state from the imported payload", () => {
    const payload = prepareImportPayload(sourceInfo, sourceMessages, "ses-destination", {
      model: { id: "model-b", providerID: "provider-b" },
      agent: "plan",
      warnings: [],
    })

    expect(payload.info.id).toBe("ses-destination")
    expect(payload.info.projectID).toBeUndefined()
    expect(payload.info.directory).toBeUndefined()
    expect(payload.info.parentID).toBeUndefined()
    expect(payload.info.permission).toBeUndefined()
    expect(payload.info.revert).toBeUndefined()
    expect(payload.info.summary).toEqual({ additions: 1, deletions: 2, files: 1 })
    expect(payload.info.model).toEqual({ id: "model-b", providerID: "provider-b" })
    expect(payload.info.agent).toBe("plan")
    expect(payload.messages[0].info.id).not.toBe(sourceMessages[0].info.id)
    expect(payload.messages[0].parts[0].messageID).toBe(payload.messages[0].info.id)
    expect(payload.messages[0].parts[0].id).not.toBe(sourceMessages[0].parts[0].id)
  })

  it("keeps message order and part counts as an independent verification", () => {
    expect(sameMessageShape(sourceMessages, sourceMessages)).toBe(true)
    expect(sameMessageShape(sourceMessages, [])).toBe(false)
    expect(
      sameMessageShape(sourceMessages, [{ ...sourceMessages[0], parts: [] }]),
    ).toBe(false)
  })

  it("rewrites message references and omits snapshot and patch parts", () => {
    const richMessages = [
      sourceMessages[0],
      {
        info: { id: "msg-2", sessionID: "ses-source", role: "assistant", parentID: "msg-1" },
        parts: [
          { id: "part-2", sessionID: "ses-source", messageID: "msg-2", type: "compaction", tail_start_id: "msg-1" },
          { id: "part-snapshot", sessionID: "ses-source", messageID: "msg-2", type: "snapshot", snapshot: "old" },
          { id: "part-patch", sessionID: "ses-source", messageID: "msg-2", type: "patch", hash: "old", files: [] },
          { id: "part-step", sessionID: "ses-source", messageID: "msg-2", type: "step-start", snapshot: "old" },
          {
            id: "part-tool",
            sessionID: "ses-source",
            messageID: "msg-2",
            type: "tool",
            state: {
              status: "completed",
              output: "old output",
              attachments: [{ id: "part-attachment", sessionID: "ses-source", messageID: "msg-2", type: "file", url: "file:///old.txt" }],
            },
          },
        ],
      },
    ]
    const payload = prepareImportPayload(sourceInfo, richMessages, "ses-destination", {
      model: sourceInfo.model,
      agent: sourceInfo.agent,
      warnings: [],
    })
    const userID = payload.messages[0].info.id
    const assistant = payload.messages[1]

    expect(assistant.info.parentID).toBe(userID)
    expect(assistant.parts.map((part) => part.type)).toEqual(["compaction", "step-start", "tool"])
    expect(assistant.parts[0].tail_start_id).toBe(userID)
    expect(assistant.parts[2].state.attachments[0].sessionID).toBe("ses-destination")
    expect(assistant.parts[2].state.attachments[0].messageID).toBe(assistant.info.id)
    expect(sameMessageShape(richMessages, payload.messages)).toBe(true)
  })

  it("keeps the source identifier ordering while avoiding global ID collisions", () => {
    const messages = [
      { info: { id: "msg_z", sessionID: "ses-source", role: "user" }, parts: [] },
      { info: { id: "msg_a", sessionID: "ses-source", role: "user" }, parts: [] },
    ]
    const payload = prepareImportPayload(sourceInfo, messages, "ses-destination", {
      model: sourceInfo.model,
      agent: sourceInfo.agent,
      warnings: [],
    })

    expect(payload.messages[0].info.id).not.toBe(messages[0].info.id)
    expect(payload.messages[1].info.id).not.toBe(messages[1].info.id)
    expect(payload.messages[0].info.id > payload.messages[1].info.id).toBe(true)
  })

  it("imports, verifies, reminds, and deletes the source session", async () => {
    const state = migrationApi({})

    const result = await migrateSession({
      api: state.api,
      sessionID: "ses-source",
      sourceDirectory: "/projects/a",
      destinationDirectory: "/projects/b",
      importSession: async (input) => {
        await (async () => {
          const payload = await Bun.file(input.filePath).json()
          expect(payload.info.id).toBe("ses-destination")
          expect(payload.info.permission).toBeUndefined()
          state.markImported(payload.messages, payload.info)
        })()
      },
    })

    expect(result).toEqual({ sessionID: "ses-destination", sourceDeleted: true, warnings: [] })
    expect(state.deleted).toEqual(["ses-destination", "ses-source"])
  })

  it("removes the destination session and preserves the source after import failure", async () => {
    const state = migrationApi({})

    await expect(
      migrateSession({
        api: state.api,
        sessionID: "ses-source",
        sourceDirectory: "/projects/a",
        destinationDirectory: "/projects/b",
        importSession: async () => {
          throw new Error("import failed")
        },
      }),
    ).rejects.toThrow("import failed")

    expect(state.deleted).toEqual(["ses-destination", "ses-destination"])
  })

  it("keeps both sessions when source deletion fails", async () => {
    const state = migrationApi({ failSourceDelete: true })
    const result = await migrateSession({
      api: state.api,
      sessionID: "ses-source",
      sourceDirectory: "/projects/a",
      destinationDirectory: "/projects/b",
      importSession: async (input) => {
        const payload = await Bun.file(input.filePath).json()
        state.markImported(payload.messages, payload.info)
      },
    })

    expect(result.sourceDeleted).toBe(false)
    expect(result.warnings[0]).toContain("source session could not be removed")
  })

  it("rejects a parent session before creating a destination", async () => {
    const state = migrationApi({ children: [{ id: "child" }] })
    await expect(
      migrateSession({
        api: state.api,
        sessionID: "ses-source",
        sourceDirectory: "/projects/a",
        destinationDirectory: "/projects/b",
        importSession: async () => undefined,
      }),
    ).rejects.toThrow("move the child sessions first")
    expect(state.deleted).toEqual([])
  })

  it("rejects a busy source before creating a destination", async () => {
    const state = migrationApi({ status: { type: "busy" } })
    await expect(
      migrateSession({
        api: state.api,
        sessionID: "ses-source",
        sourceDirectory: "/projects/a",
        destinationDirectory: "/projects/b",
        importSession: async () => undefined,
      }),
    ).rejects.toThrow("became busy")
    expect(state.deleted).toEqual([])
  })

  it("selects destination model and agent alternatives with warnings", async () => {
    const state = migrationApi({
      models: [{ id: "model-b", providerID: "provider-b", enabled: true, variants: [] }],
      agents: [{ name: "plan", mode: "primary", hidden: false }],
      destinationProjectID: "project-b",
    })
    const result = await migrateSession({
      api: state.api,
      sessionID: "ses-source",
      sourceDirectory: "/projects/a",
      destinationDirectory: "/projects/b",
      destinationProjectID: "project-b",
      importSession: async (input) => {
        const payload = await Bun.file(input.filePath).json()
        state.markImported(payload.messages, payload.info)
      },
    })

    expect(result.warnings).toEqual([
      "Model provider-a/model-a is unavailable; selected provider-b/model-b.",
      "Agent build is unavailable; selected plan.",
    ])
  })
})
