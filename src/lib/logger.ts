// Lightweight structured logger over console.
//
// This is the single sanctioned console sink in the codebase (the no-console
// ESLint rule is disabled only for this file). It has no third-party
// dependencies so content scripts can import it; the eslint.config.js rule on
// entrypoints/*.content/** keeps the content bundle free of third-party code.

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
