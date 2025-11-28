import path from 'node:path';

export const SILENT_EXEC_PROMPT = `NOTE FOR AGENT: When running shell commands or spawning subprocesses, please run non-interactively and avoid creating new terminal windows. Emit results only to stdout/stderr and avoid launching additional terminal windows that could confuse the parent controller.`;

export class StructuredError extends Error {
    code: string;
    constructor(code: string, message: string) {
        super(message);
        this.code = code;
    }
}

export function serializeErrorForClient(error: unknown) {
    if (error instanceof StructuredError) {
        return { code: error.code, message: error.message };
    }
    if (error instanceof Error) {
        return { message: error.message };
    }
    try {
        return { message: String(error) };
    } catch {
        return { message: 'Unknown error' };
    }
}

export function tokenizeCommandLine(input: string) {
    const tokens: string[] = [];
    let current = '';
    let quote: '"' | "'" | undefined;
    let escaping = false;
    for (let i = 0; i < input.length; i += 1) {
        const char = input[i];
        if (quote) {
            if (escaping) {
                current += char;
                escaping = false;
                continue;
            }
            if (char === '\\') {
                escaping = true;
                continue;
            }
            if (char === quote) {
                quote = undefined;
                continue;
            }
            current += char;
            continue;
        }
        if (char === '"' || char === "'") {
            quote = char as any;
            continue;
        }
        if (/\s/.test(char)) {
            if (current.length > 0) {
                tokens.push(current);
                current = '';
            }
            continue;
        }
        current += char;
    }
    if (current.length > 0) tokens.push(current);
    return tokens;
}

export function formatWorkspaceError(error: unknown) {
    return error instanceof Error ? error.message : String(error);
}

export function normalizeForComparison(target: string) {
    return path.normalize(target).toLowerCase();
}

export function resolveWorkspaceRoot(input: string) {
    return path.isAbsolute(input) ? path.normalize(input) : path.resolve(process.cwd(), input);
}

export function readTimeoutEnv(name: string, fallback: number) {
    const raw = process.env[name];
    if (!raw || raw.trim().length === 0) {
        return fallback;
    }
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed < 0) {
        return fallback;
    }
    return parsed;
}

export function readPriorityEnv(name: string, fallback: number) {
    const raw = process.env[name];
    if (!raw || raw.trim().length === 0) {
        return fallback;
    }
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) {
        return fallback;
    }
    const clamped = Math.max(-5, Math.min(5, Math.trunc(parsed)));
    return clamped;
}

export default null;
