import type * as vscode from 'vscode';

let channel: vscode.OutputChannel | undefined = undefined;
let usingVscode = false;

function ensureChannel() {
    if (channel) return channel;
    try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-unsafe-assignment
        const vr = require('vscode') as typeof import('vscode');
        channel = vr.window.createOutputChannel('Gemini CLI MCP');
        usingVscode = true;
        return channel;
    } catch {
        usingVscode = false;
        // create a fallback OutputChannel-like object that writes to stdout
        const fallback = {
            appendLine: (s: string) => { try { process.stdout.write(s + '\n'); } catch {} },
            show: (_preserveFocus?: boolean) => { /* no-op */ },
            dispose: () => { /* no-op */ }
        } as unknown as vscode.OutputChannel;
        channel = fallback;
        return channel;
    }
}

function stringify(v: unknown) {
    if (v instanceof Error) return `${v.name}: ${v.message}`;
    try { return JSON.stringify(v); } catch { return String(v); }
}

export const logger = {
    info(msg: string, details?: unknown) {
        const ch = ensureChannel();
        const line = `[info] ${msg}` + (details !== undefined ? ` ${stringify(details)}` : '');
        ch.appendLine(line);
    },
    warn(msg: string, details?: unknown) {
        const ch = ensureChannel();
        const line = `[warn] ${msg}` + (details !== undefined ? ` ${stringify(details)}` : '');
        ch.appendLine(line);
    },
    error(msg: string, details?: unknown) {
        const ch = ensureChannel();
        const line = `[error] ${msg}` + (details !== undefined ? ` ${stringify(details)}` : '');
        ch.appendLine(line);
    },
    debug(msg: string, details?: unknown) {
        const ch = ensureChannel();
        const line = `[debug] ${msg}` + (details !== undefined ? ` ${stringify(details)}` : '');
        ch.appendLine(line);
    },
    show(preserveFocus = false) {
        const ch = ensureChannel();
        if (ch) ch.show(preserveFocus);
    },
    // testing helper
    _setChannelForTests(c: vscode.OutputChannel | undefined) {
        channel = c;
        usingVscode = !!c;
    }
};
