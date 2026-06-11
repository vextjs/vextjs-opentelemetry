import { describe, expect, it } from "vitest";

import {
  hasAutoInstrumentationSignal,
  isOtelSdkDisabled,
  isVextAutoPreload,
  isVextTruthy,
  resolvePreloadGate,
  shouldForcePreloadSdk,
  type EnvLike,
} from "../src/core/preload-gate.js";

describe("preload gate", () => {
  it("OTEL_SDK_DISABLED 仅按官方 true 语义处理", () => {
    expect(isOtelSdkDisabled({ OTEL_SDK_DISABLED: "true" })).toBe(true);
    expect(isOtelSdkDisabled({ OTEL_SDK_DISABLED: "TRUE" })).toBe(true);
    expect(isOtelSdkDisabled({ OTEL_SDK_DISABLED: "1" })).toBe(false);
    expect(isOtelSdkDisabled({ OTEL_SDK_DISABLED: "yes" })).toBe(false);
  });

  it("Vext 私有 env 支持常见 truthy 值", () => {
    expect(isVextTruthy("1")).toBe(true);
    expect(isVextTruthy("true")).toBe(true);
    expect(isVextTruthy("yes")).toBe(true);
    expect(isVextTruthy("on")).toBe(true);
    expect(isVextTruthy("0")).toBe(false);
  });

  it("识别禁用路径", () => {
    expect(resolvePreloadGate({}, { OTEL_SDK_DISABLED: "true" })).toEqual({
      disabled: true,
      reason: "otel-sdk-disabled",
    });
    expect(resolvePreloadGate({}, { VEXT_OTEL_DISABLED: "1" })).toEqual({
      disabled: true,
      reason: "vext-disabled",
    });
    expect(resolvePreloadGate({}, { VEXT_OTEL_PRELOAD: "0" })).toEqual({
      disabled: true,
      reason: "vext-preload-disabled",
    });
    expect(resolvePreloadGate({ enabled: false }, {})).toEqual({
      disabled: true,
      reason: "package-disabled",
    });
  });

  it("识别 Vext 自动 preload 与强制 SDK 信号", () => {
    const vextEnv: EnvLike = { VEXT_ROOT: "E:/app", VEXT_DEV_MODE: "1" };
    expect(isVextAutoPreload(vextEnv)).toBe(true);
    expect(isVextAutoPreload({ VEXT_ROOT: "E:/app" })).toBe(false);

    expect(shouldForcePreloadSdk({ preloadSdk: true }, vextEnv)).toBe(true);
    expect(shouldForcePreloadSdk({}, { VEXT_OTEL_FORCE_SDK: "1" })).toBe(true);
    expect(
      shouldForcePreloadSdk({}, { OTEL_NODE_ENABLED_INSTRUMENTATIONS: "http" }),
    ).toBe(true);
    expect(hasAutoInstrumentationSignal({ OTEL_NODE_DISABLED_INSTRUMENTATIONS: "fs" })).toBe(
      true,
    );
  });
});
