import type { OtelConfig } from "./types.js";

export type EnvLike = Record<string, string | undefined>;

export type PreloadSkipReason =
  | "otel-sdk-disabled"
  | "vext-disabled"
  | "vext-preload-disabled"
  | "package-disabled"
  | "vext-deferred"
  | "export-none";

export interface PreloadGateResult {
  disabled: boolean;
  reason?: PreloadSkipReason;
}

export function isVextTruthy(value: string | undefined): boolean {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

export function isOtelSdkDisabled(env: EnvLike = process.env): boolean {
  return env.OTEL_SDK_DISABLED?.trim().toLowerCase() === "true";
}

export function resolvePreloadGate(
  config: Pick<OtelConfig, "enabled">,
  env: EnvLike = process.env,
): PreloadGateResult {
  if (isOtelSdkDisabled(env)) {
    return { disabled: true, reason: "otel-sdk-disabled" };
  }
  if (isVextTruthy(env.VEXT_OTEL_DISABLED)) {
    return { disabled: true, reason: "vext-disabled" };
  }
  if (env.VEXT_OTEL_PRELOAD === "0") {
    return { disabled: true, reason: "vext-preload-disabled" };
  }
  if (config.enabled === false) {
    return { disabled: true, reason: "package-disabled" };
  }
  return { disabled: false };
}

export function isVextAutoPreload(env: EnvLike = process.env): boolean {
  return Boolean(env.VEXT_ROOT && (env.VEXT_DEV_MODE === "1" || env.VEXT_MODE === "start"));
}

export function hasAutoInstrumentationSignal(env: EnvLike = process.env): boolean {
  return (
    isVextTruthy(env.VEXT_OTEL_AUTO_INSTRUMENTATION) ||
    Boolean(env.OTEL_NODE_ENABLED_INSTRUMENTATIONS) ||
    Boolean(env.OTEL_NODE_DISABLED_INSTRUMENTATIONS)
  );
}

export function shouldForcePreloadSdk(
  config: Pick<OtelConfig, "preloadSdk">,
  env: EnvLike = process.env,
): boolean {
  return (
    config.preloadSdk === true ||
    isVextTruthy(env.VEXT_OTEL_FORCE_SDK) ||
    hasAutoInstrumentationSignal(env)
  );
}
