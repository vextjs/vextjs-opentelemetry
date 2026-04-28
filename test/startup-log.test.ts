import { describe, expect, it } from "vitest"

import {
  formatStartupExportDesc,
  shouldLogStartupSummary,
} from "../src/core/startup-log.js"

describe("startup log helpers", () => {
  it("deferred export 默认不打印启动摘要", () => {
    expect(shouldLogStartupSummary("none")).toBe(false)
  })

  it("file 模式保留启动摘要", () => {
    expect(shouldLogStartupSummary("file")).toBe(true)
    expect(
      formatStartupExportDesc("file", "E:/otel-data", "ignored", "http"),
    ).toBe("exporting to E:/otel-data")
  })

  it("otlp-grpc 模式保留启动摘要并带 endpoint", () => {
    expect(shouldLogStartupSummary("otlp-grpc")).toBe(true)
    expect(
      formatStartupExportDesc("otlp-grpc", undefined, "collector:4317", "grpc"),
    ).toBe("exporting to collector:4317 [grpc]")
  })
})

