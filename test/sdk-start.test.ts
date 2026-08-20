import { afterEach, describe, expect, it, vi } from "vitest";

import { shutdownOtelSdk } from "../src/core/sdk-start.js";

const SDK_RUNTIME_KEY = Symbol.for("vextjs-opentelemetry.v1.sdk-runtime");
const runtimeStore = globalThis as unknown as Record<symbol, unknown>;

describe("shutdownOtelSdk", () => {
  afterEach(() => {
    delete runtimeStore[SDK_RUNTIME_KEY];
  });

  it("is a no-op before the SDK is initialized", async () => {
    await expect(shutdownOtelSdk()).resolves.toBeUndefined();
  });

  it("shares one shutdown promise across repeated callers", async () => {
    const shutdown = vi.fn(async () => undefined);
    runtimeStore[SDK_RUNTIME_KEY] = {
      started: true,
      shutdown,
    };

    const first = shutdownOtelSdk();
    const second = shutdownOtelSdk();

    expect(first).toBe(second);
    await expect(Promise.all([first, second])).resolves.toEqual([
      undefined,
      undefined,
    ]);
    expect(shutdown).toHaveBeenCalledTimes(1);
  });
});
