// Lightweight structured logger over console.
//
// This is the single sanctioned console sink in the codebase (the no-console
// ESLint rule is disabled only for this file). Background and popup/options
// entrypoints additionally initialize Sentry in a later phase; that Sentry
// init MUST NOT be imported by content scripts -- the eslint.config.js rule on
// src/content/** enforces that the content bundle stays free of third-party
// code.

type LogLevel = "debug" | "info" | "warn" | "error";
type LogContext = Record<string, unknown>;

function emit(level: LogLevel, message: string, context?: LogContext): void {
  const entry = { level, message, ...(context ?? {}) };
  console[level](JSON.stringify(entry));
}

export const logger = {
  debug: (message: string, context?: LogContext): void => emit("debug", message, context),
  info: (message: string, context?: LogContext): void => emit("info", message, context),
  warn: (message: string, context?: LogContext): void => emit("warn", message, context),
  error: (message: string, context?: LogContext): void => emit("error", message, context),
} as const;
