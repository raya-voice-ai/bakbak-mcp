/**
 * A minimal structured logger: one JSON object per line, on stderr.
 *
 * stdout is reserved for the MCP protocol in stdio mode, so nothing here ever
 * writes there. Callers must never pass API keys, tokens or synthesis text in
 * `fields`; log sizes, ids, statuses and timings instead.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export type LogFields = Record<string, unknown>;

export interface Logger {
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
  /** A logger that adds `fields` to every line. */
  child(fields: LogFields): Logger;
}

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface LoggerOptions {
  level?: LogLevel;
  /** Where lines go; defaults to `process.stderr`. */
  write?: (line: string) => void;
  base?: LogFields;
}

/** Parses `LOG_LEVEL`; anything unknown falls back to `info`. */
export function parseLogLevel(value: string | undefined): LogLevel {
  const v = value?.trim().toLowerCase();
  return v === 'debug' || v === 'info' || v === 'warn' || v === 'error' ? v : 'info';
}

function serialize(value: unknown): unknown {
  if (value instanceof Error) {
    // Only the class name and message: SDK errors never carry keys, and stacks are noise in JSON logs.
    return { name: value.name, message: value.message };
  }
  return value;
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const min = LEVELS[options.level ?? 'info'];
  const write =
    options.write ??
    ((line: string) => {
      process.stderr.write(line);
    });
  const make = (base: LogFields): Logger => {
    const emit = (level: LogLevel, msg: string, fields?: LogFields): void => {
      if (LEVELS[level] < min) return;
      const record: LogFields = { time: new Date().toISOString(), level, msg, ...base };
      if (fields) {
        for (const [k, v] of Object.entries(fields)) {
          if (v !== undefined) record[k] = serialize(v);
        }
      }
      write(JSON.stringify(record) + '\n');
    };
    return {
      debug: (msg, fields) => {
        emit('debug', msg, fields);
      },
      info: (msg, fields) => {
        emit('info', msg, fields);
      },
      warn: (msg, fields) => {
        emit('warn', msg, fields);
      },
      error: (msg, fields) => {
        emit('error', msg, fields);
      },
      child: (fields) => make({ ...base, ...fields }),
    };
  };
  return make(options.base ?? {});
}

/** A logger that drops everything (tests, and callers that opt out). */
export const silentLogger: Logger = createLogger({ write: () => undefined });
