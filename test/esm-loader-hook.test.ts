import { afterEach, describe, expect, it, vi } from "vitest";

import {
  registerEsmInstrumentationHook,
  type EsmLoaderHookModuleApi,
} from "../src/core/esm-loader-hook.js";

const ESM_LOADER_HOOK_STATE_KEY = Symbol.for(
  "vextjs-opentelemetry.v1.esm-loader-hook",
);
const runtimeStore = globalThis as unknown as Record<symbol, unknown>;

describe("registerEsmInstrumentationHook", () => {
  afterEach(() => {
    delete runtimeStore[ESM_LOADER_HOOK_STATE_KEY];
  });

  it("registers the local OpenTelemetry ESM hook exactly once", () => {
    const resolve = vi.fn(
      () => "C:\\fixture\\node_modules\\@opentelemetry\\instrumentation\\hook.mjs",
    );
    const createRequire = vi.fn(() => ({ resolve }));
    const register = vi.fn();
    const moduleApi = {
      createRequire,
      register,
    } as unknown as EsmLoaderHookModuleApi;
    const parentURL = "file:///fixture/instrumentation.js";

    expect(registerEsmInstrumentationHook(moduleApi, parentURL)).toBe(true);
    expect(createRequire).toHaveBeenCalledWith(parentURL);
    expect(register).toHaveBeenCalledTimes(1);

    const [hookUrl, registeredParentUrl] = register.mock.calls[0] ?? [];
    expect(hookUrl).toBeInstanceOf(URL);
    expect((hookUrl as URL).pathname).toContain("/hook.mjs");
    expect(registeredParentUrl).toBe(parentURL);

    expect(registerEsmInstrumentationHook(moduleApi, parentURL)).toBe(true);
    expect(register).toHaveBeenCalledTimes(1);
  });

  it("keeps the existing startup path on Node versions without module.register", () => {
    const createRequire = vi.fn();
    const moduleApi = {
      createRequire,
    } as unknown as EsmLoaderHookModuleApi;

    expect(registerEsmInstrumentationHook(moduleApi)).toBe(false);
    expect(createRequire).not.toHaveBeenCalled();
  });
});
