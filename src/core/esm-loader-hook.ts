import * as nodeModule from "node:module";
import { pathToFileURL } from "node:url";

const ESM_LOADER_HOOK_STATE_KEY = Symbol.for(
  "vextjs-opentelemetry.v1.esm-loader-hook",
);

interface EsmLoaderHookState {
  registered: boolean;
}

export type EsmLoaderHookModuleApi = Pick<typeof nodeModule, "createRequire"> & {
  register?: (specifier: string | URL, parentURL?: string | URL) => void;
};

/**
 * Registers OpenTelemetry ESM instrumentation before application modules load.
 *
 * Node only applies module.register() hooks to imports that occur after
 * registration, so the public preload entry calls this before it loads the
 * SDK and configuration continuation.
 */
export function registerEsmInstrumentationHook(
  moduleApi: EsmLoaderHookModuleApi = nodeModule,
  parentURL: string | URL = import.meta.url,
): boolean {
  const runtimeStore = globalThis as unknown as Record<
    symbol,
    EsmLoaderHookState | undefined
  >;
  const state = runtimeStore[ESM_LOADER_HOOK_STATE_KEY];

  if (state?.registered) {
    return true;
  }

  if (typeof moduleApi.register !== "function") {
    return false;
  }

  try {
    const require = moduleApi.createRequire(parentURL);
    const hookUrl = pathToFileURL(
      require.resolve("@opentelemetry/instrumentation/hook.mjs"),
    );

    moduleApi.register(hookUrl, parentURL);
    runtimeStore[ESM_LOADER_HOOK_STATE_KEY] = { registered: true };
    return true;
  } catch (err) {
    console.warn(
      "[vextjs-opentelemetry/instrumentation] Failed to register ESM auto-instrumentation hook:",
      (err as Error).message,
    );
    return false;
  }
}
