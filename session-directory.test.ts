import { describe, expect, it } from "bun:test"
import { isSessionIdle, shouldUseNativeMove } from "./session-directory"
import { isLoopbackAddress } from "./session-migration"

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

  it("recognizes loopback aliases used by the local host", () => {
    expect(isLoopbackAddress("127.0.0.2")).toBe(true)
    expect(isLoopbackAddress("::1")).toBe(true)
    expect(isLoopbackAddress("100.64.0.1")).toBe(false)
  })
})
