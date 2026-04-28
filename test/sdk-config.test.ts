import { describe, expect, it, vi } from "vitest";

import { createExportSignalLogger } from "../src/core/sdk-config.js";

describe("createExportSignalLogger", () => {
  it("初始成功和连续成功都不打印日志", () => {
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
    };
    const signalLogger = createExportSignalLogger("Metrics", "grpc h2c", logger);

    signalLogger.onSuccess();
    signalLogger.onSuccess();

    expect(logger.info).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("首次失败只告警一次，连续失败不重复刷屏", () => {
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
    };
    const signalLogger = createExportSignalLogger("Trace", "grpc h2c", logger);

    signalLogger.onFailure(new Error("timeout"));
    signalLogger.onFailure(new Error("timeout again"));

    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      "[vextjs-opentelemetry] Trace export FAILED (grpc h2c): timeout",
    );
    expect(logger.info).not.toHaveBeenCalled();
  });

  it("失败后首次恢复只提示一次", () => {
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
    };
    const signalLogger = createExportSignalLogger("Logs", "grpc h2c", logger);

    signalLogger.onFailure(new Error("collector unavailable"));
    signalLogger.onSuccess();
    signalLogger.onSuccess();

    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.info).toHaveBeenCalledTimes(1);
    expect(logger.info).toHaveBeenCalledWith(
      "[vextjs-opentelemetry] Logs export recovered (grpc h2c)",
    );
  });

  it("恢复后再次失败，会重新告警", () => {
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
    };
    const signalLogger = createExportSignalLogger("Trace", "grpc h2c", logger);

    signalLogger.onFailure(new Error("timeout"));
    signalLogger.onSuccess();
    signalLogger.onFailure(new Error("collector reset"));

    expect(logger.warn).toHaveBeenCalledTimes(2);
    expect(logger.warn).toHaveBeenNthCalledWith(
      1,
      "[vextjs-opentelemetry] Trace export FAILED (grpc h2c): timeout",
    );
    expect(logger.warn).toHaveBeenNthCalledWith(
      2,
      "[vextjs-opentelemetry] Trace export FAILED (grpc h2c): collector reset",
    );
    expect(logger.info).toHaveBeenCalledTimes(1);
  });
});

