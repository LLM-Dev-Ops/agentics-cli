export interface Logger {
  info(event: string, data?: Record<string, unknown>): void;
  warn(event: string, data?: Record<string, unknown>): void;
  error(event: string, error: Error, data?: Record<string, unknown>): void;
}

export function createLogger(service: string): Logger {
  const write = (level: string, event: string, extra: Record<string, unknown> = {}) => {
    const entry = {
      timestamp: new Date().toISOString(),
      level,
      service,
      event,
      ...extra,
    };
    process.stderr.write(JSON.stringify(entry) + '\n');
  };

  return {
    info: (event, data) => write('info', event, data),
    warn: (event, data) => write('warn', event, data),
    error: (event, err, data) =>
      write('error', event, {
        error: err.message,
        stack: err.stack,
        ...data,
      }),
  };
}
