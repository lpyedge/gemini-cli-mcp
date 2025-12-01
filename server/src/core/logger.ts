type LogLevel = 'info' | 'warn' | 'error' | 'debug';

const levelPrefix: Record<LogLevel, string> = {
    info: '[info]',
    warn: '[warn]',
    error: '[error]',
    debug: '[debug]'
};

function write(level: LogLevel, message: string, details?: unknown) {
    const payload = details === undefined ? message : `${message} ${stringify(details)}`;
    // In MCP stdio mode, stdout is reserved for JSON-RPC protocol messages.
    // All diagnostic logs MUST go to stderr to avoid corrupting the transport.
    const line = `[server] ${levelPrefix[level]} ${payload}`;
    switch (level) {
        case 'warn':
        case 'error':
            console.error(line);
            break;
        case 'debug':
            // debug also goes to stderr
            console.error(line);
            break;
        default:
            // info goes to stderr (not stdout!) to avoid MCP protocol interference
            console.error(line);
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
