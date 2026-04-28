import type { ExportMode } from "./types.js"

export function shouldLogStartupSummary(
  exportMode: ExportMode,
): exportMode is Exclude<ExportMode, "none"> {
  return exportMode !== "none"
}

export function formatStartupExportDesc(
  exportMode: Exclude<ExportMode, "none">,
  exportDir: string | undefined,
  endpoint: string,
  protocol: "http" | "grpc",
): string {
  if (exportMode === "file") {
    return `exporting to ${exportDir}`
  }

  return `exporting to ${endpoint} [${protocol}]`
}


