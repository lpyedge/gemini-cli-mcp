type LogLevel = 'info' | 'warn' | 'error' | 'debug';

const levelPrefix: Record<LogLevel, string> = {
    info: '[info]',
    warn: '[warn]',
    error: '[error]',
    debug: '[debug]'
};

function write(level: LogLevel, message: string, details?: unknown) {
    const payload = details === undefined ? message : `${message} ${stringify(details)}`;
    switch (level) {
        case 'warn':
            console.warn(`[server] ${levelPrefix[level]} ${payload}`);
            break;
        case 'error':
            console.error(`[server] ${levelPrefix[level]} ${payload}`);
            break;
        case 'debug':
            console.debug(`[server] ${levelPrefix[level]} ${payload}`);
            break;
        default:
            console.log(`[server] ${levelPrefix[level]} ${payload}`);
            break;
    }
}

function stringify(value: unknown) {
    if (value instanceof Error) {
        return `${value.name}: ${value.message}`;
    }
    try {
        return JSON.stringify(value);
    } catch {
        return String(value);
    }
}

export const logger = {
    info(message: string, details?: unknown) {
        write('info', message, details);
    },
    warn(message: string, details?: unknown) {
        write('warn', message, details);
    },
    error(message: string, details?: unknown) {
        write('error', message, details);
    },
    debug(message: string, details?: unknown) {
        write('debug', message, details);
    }
};
