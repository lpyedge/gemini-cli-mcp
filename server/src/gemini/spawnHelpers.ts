import fsSync from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { logger } from '../core/logger.js';

export let geminiBin = resolveGeminiBinary((process.env.GEMINI_CLI ?? '').trim() || autoDiscoverGeminiBinary() || 'gemini');

export function setGeminiBin(raw: string) {
    geminiBin = resolveGeminiBinary(raw);
}

function autoDiscoverGeminiBinary() {
    if (process.platform !== 'win32') {
        return undefined;
    }
    const fromCommonPaths = findGeminiInCommonPaths();
    if (fromCommonPaths) {
        logger.info('spawn: auto-detected Gemini CLI via common paths', {
            geminiPath: fromCommonPaths
        });
        return fromCommonPaths;
    }
    const fromWhere = findGeminiViaWhere();
    if (fromWhere) {
        logger.info("spawn: located Gemini CLI via 'where'", {
            geminiPath: fromWhere
        });
        return fromWhere;
    }
    return undefined;
}

function findGeminiInCommonPaths() {
    const candidates = [];
    const localApp = process.env.LOCALAPPDATA;
    const programFiles = process.env.ProgramFiles;
    const programFilesX86 = process.env['ProgramFiles(x86)'];
    const userProfile = process.env.USERPROFILE;
    const baseDirs = [localApp, programFiles, programFilesX86, userProfile].filter(
        (d): d is string => !!d && d.trim().length > 0
    );
    const subPaths = [['Programs', 'Gemini CLI'], ['Google', 'Gemini CLI'], ['Gemini CLI'], ['AppData', 'Local', 'Gemini CLI']];
    const fileNames = ['gemini.exe', 'gemini.cmd', path.join('bin', 'gemini.exe'), path.join('bin', 'gemini.cmd')];
    for (const base of baseDirs) {
        for (const sub of subPaths) {
            const root = path.join(base, ...sub);
            for (const file of fileNames) {
                candidates.push(path.join(root, file));
            }
        }
    }
    for (const candidate of candidates) {
        if (candidate && fsSync.existsSync(candidate)) {
            return candidate;
        }
    }
    return undefined;
}

function findGeminiViaWhere() {
    try {
        // Use explicit where.exe to avoid PowerShell alias (where is an alias in PS)
        const result = spawnSync('where.exe', ['gemini'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
        if (result.status !== 0) {
            return undefined;
        }
        const lines = (result.stdout || '').split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0 && fsSync.existsSync(l));
        if (lines.length === 0) return undefined;
        const exe = lines.find((l) => l.toLowerCase().endsWith('.exe'));
        if (exe) return exe;
        const cmd = lines.find((l) => l.toLowerCase().endsWith('.cmd') || l.toLowerCase().endsWith('.bat'));
        return cmd ?? lines[0];
    } catch {
        return undefined;
    }
}

function resolveGeminiBinary(raw: string) {
    if (process.platform === 'win32') {
        const hasSeparator = raw.includes(path.sep);
        const ext = path.extname(raw).toLowerCase();
        if (hasSeparator && !ext) {
            const withCmd = `${raw}.cmd`;
            const withExe = `${raw}.exe`;
            if (fsSync.existsSync(withCmd)) return withCmd;
            if (fsSync.existsSync(withExe)) return withExe;
        }
    }
    return raw;
}

export function buildSpawnCommand(taskArgs: string[]) {
    if (process.platform === 'win32') {
        const ext = path.extname(geminiBin).toLowerCase();
        if (ext === '.cmd' || ext === '.bat') {
            try {
                const content = fsSync.readFileSync(geminiBin, 'utf8');
                const m1 = content.match(/node\s+["']?([^"'\s]+\.js)["']?/i);
                const m2 = content.match(/["']([^"']+\.js)["']/i);
                const candidate = (m1 && m1[1]) || (m2 && m2[1]);
                if (candidate) {
                    const scriptPath = path.isAbsolute(candidate) ? candidate : path.resolve(path.dirname(geminiBin), candidate);
                    if (fsSync.existsSync(scriptPath)) {
                        return { command: process.execPath, args: [scriptPath, ...taskArgs] };
                    }
                }
            } catch {
                // fall through
            }
            return { command: process.env.ComSpec || 'C:\\Windows\\System32\\cmd.exe', args: ['/c', geminiBin, ...taskArgs] };
        }
    }
    return { command: geminiBin, args: taskArgs };
}

export default null;
