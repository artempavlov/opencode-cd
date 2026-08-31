import { describe, expect, it } from "bun:test"
import { isSessionIdle, shouldUseNativeMove } from "./session-directory"

describe("session move strategy", () => {
  it("uses the native move inside one project, including the global non-Git project", () => {
    expect(shouldUseNativeMove("project-a", "project-a")).toBe(true)
    expect(shouldUseNativeMove("global", "global")).toBe(true)
  })

  it("uses migration for a different project", () => {
    expect(shouldUseNativeMove("project-a", "project-b")).toBe(false)
  })

  it("rejects busy and retrying sessions", () => {
    expect(isSessionIdle({ type: "idle" })).toBe(true)
    expect(isSessionIdle(undefined)).toBe(true)
    expect(isSessionIdle({ type: "busy" })).toBe(false)
    expect(isSessionIdle({ type: "retry" })).toBe(false)
  })
})
