import { debug, info, warn, error } from '@tauri-apps/plugin-log';
import { isAndroidBubble } from './android-runtime';

const recentLogs: string[] = [];
const maxRecentLogs = 1000;

function rememberLog(level: string, contextName: string, args: unknown[]) {
  const message = args.map(arg => arg instanceof Error ? `${arg.message}\n${arg.stack ?? ''}` : String(arg)).join(' ');
  recentLogs.push(`${new Date().toISOString()} ${level} [${contextName}] ${message}`);
  if (recentLogs.length > maxRecentLogs) recentLogs.splice(0, recentLogs.length - maxRecentLogs);
}

export function getRecentLogs(): string {
  return recentLogs.join('\n');
}

/**
 * Инициализирует перехват console.* для трансляции в нативный логгер Tauri (tauri-plugin-log).
 * В релизе логи сохраняются в памяти процесса, в dev также записываются в файл.
 */
export function initLoggerForwarding(contextName: string = 'frontend'): void {
  if (isAndroidBubble) return;
  const originalLog = console.log;
  const originalInfo = console.info;
  const originalWarn = console.warn;
  const originalError = console.error;
  const originalDebug = console.debug;

  const formatArgs = (args: unknown[]): string => {
    return args
      .map(arg => {
        if (arg instanceof Error) {
          return `${arg.message}\n${arg.stack ?? ''}`;
        }
        if (typeof arg === 'object' && arg !== null) {
          try {
            return JSON.stringify(arg);
          } catch {
            return String(arg);
          }
        }
        return String(arg);
      })
      .join(' ');
  };

  console.log = (...args: unknown[]) => {
    rememberLog('INFO', contextName, args);
    originalLog(...args);
    void info(`[${contextName}] ${formatArgs(args)}`).catch(() => {});
  };

  console.info = (...args: unknown[]) => {
    rememberLog('INFO', contextName, args);
    originalInfo(...args);
    void info(`[${contextName}] ${formatArgs(args)}`).catch(() => {});
  };

  console.debug = (...args: unknown[]) => {
    rememberLog('DEBUG', contextName, args);
    originalDebug(...args);
    void debug(`[${contextName}] ${formatArgs(args)}`).catch(() => {});
  };

  console.warn = (...args: unknown[]) => {
    rememberLog('WARN', contextName, args);
    originalWarn(...args);
    void warn(`[${contextName}] ${formatArgs(args)}`).catch(() => {});
  };

  console.error = (...args: unknown[]) => {
    rememberLog('ERROR', contextName, args);
    originalError(...args);
    void error(`[${contextName}] ${formatArgs(args)}`).catch(() => {});
  };

  window.addEventListener('error', (event) => {
    rememberLog('ERROR', `${contextName}:window-error`, [event.message, event.filename, event.lineno, event.colno]);
    void error(`[${contextName}:window-error] ${event.message} at ${event.filename}:${event.lineno}:${event.colno}`).catch(() => {});
  });

  window.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason instanceof Error ? `${event.reason.message}\n${event.reason.stack ?? ''}` : String(event.reason);
    rememberLog('ERROR', `${contextName}:unhandledrejection`, [reason]);
    void error(`[${contextName}:unhandledrejection] ${reason}`).catch(() => {});
  });
}
