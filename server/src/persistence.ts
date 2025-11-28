import fs from 'node:fs/promises';
import path from 'node:path';
import fsSync from 'node:fs';
import type { TaskRecord } from './types.js';

export async function persistTasksToFile(stateFile: string, tasks: Map<string, TaskRecord>) {
    const payload = Array.from(tasks.values()).map((task) => {
        const { log, ...rest } = task as any;
        return rest;
    });
    await fs.mkdir(path.dirname(stateFile), { recursive: true });
    await fs.writeFile(stateFile, JSON.stringify(payload, null, 2), 'utf8');
}

export async function loadPersistedTasksFromFile(
    stateFile: string,
    logDir: string,
    tasks: Map<string, TaskRecord>,
    assertAllowedTaskCwd: (cwd: any) => string,
    fileExists: (p: string) => Promise<boolean>
) {
    try {
        const raw = await fs.readFile(stateFile, 'utf8');
        const saved: TaskRecord[] = JSON.parse(raw);
        await fs.mkdir(logDir, { recursive: true });
        for (const record of saved) {
            record.logFile = record.logFile ?? path.join(logDir, `${record.id}.log`);
            try {
                record.cwd = assertAllowedTaskCwd(record.cwd);
            } catch (error) {
                record.status = 'failed';
                record.error = (error instanceof Error ? error.message : String(error));
            }
            if (record.log && record.log.length > 0 && !(await fileExists(record.logFile))) {
                const buffer = record.log.join('');
                await fs.writeFile(record.logFile, buffer, 'utf8');
                record.logLength = Buffer.byteLength(buffer, 'utf8');
            } else if (await fileExists(record.logFile)) {
                const stat = await fs.stat(record.logFile);
                record.logLength = stat.size;
            } else {
                record.logLength = record.logLength ?? 0;
            }
            record.log = undefined;
            if (!['succeeded', 'failed', 'canceled'].includes(record.status)) {
                record.status = 'failed';
                record.error = 'Server restarted while task was running.';
                record.updatedAt = Date.now();
                record.completedAt = record.completedAt ?? Date.now();
            }
            record.jobId = undefined;
            tasks.set(record.id, record);
        }
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
            console.error('Failed to load Gemini CLI MCP task state', error);
        }
    }
}

export default null;
