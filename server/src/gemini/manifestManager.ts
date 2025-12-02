import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { jsonSchemaToZod, dereferenceSchema } from '../lib/schemaUtils.js';
import { logger } from '../core/logger.js';
import { serializeErrorForClient, formatWorkspaceError, normalizeForComparison } from '../core/utils.js';

export type ManifestInvocationAttempt = {
    label: string;
    args: string[];
    stdin?: string;
    timeoutMs?: number;
};

function toKebabCase(value: string) {
    return value
        .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
        .replace(/[_\s]+/g, '-')
        .toLowerCase();
}

function stripUndefinedDeep(obj: Record<string, unknown>) {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
        if (value === undefined || value === null) {
            continue;
        }
        if (Array.isArray(value)) {
            out[key] = value
                .map((entry) => (typeof entry === 'object' && entry !== null ? stripUndefinedDeep(entry as Record<string, unknown>) : entry))
                .filter((entry) => entry !== undefined && entry !== null);
            continue;
        }
        if (typeof value === 'object') {
            out[key] = stripUndefinedDeep(value as Record<string, unknown>);
            continue;
        }
        out[key] = value;
    }
    return out;
}

function manifestArgsToFlags(args: Record<string, unknown>) {
    const flags: string[] = [];
    for (const [key, value] of Object.entries(args)) {
        if (value === undefined || value === null) {
            continue;
        }
        if (key === 'content' && typeof value === 'string') {
            // Large free-form content should be delivered via stdin JSON instead of CLI flags.
            continue;
        }
        const flagName = `--${toKebabCase(key)}`;
        if (Array.isArray(value)) {
            for (const entry of value) {
                if (entry === undefined || entry === null) {
                    continue;
                }
                flags.push(flagName, String(entry));
            }
            continue;
        }
        if (typeof value === 'object') {
            flags.push(flagName, JSON.stringify(value));
            continue;
        }
        flags.push(flagName, String(value));
    }
    return flags;
}

function buildManifestInvocationAttempts(toolName: string, args: Record<string, unknown>, manifestToolTimeoutMs: number): ManifestInvocationAttempt[] {
    const sanitized = stripUndefinedDeep(args);
    const jsonPayload = JSON.stringify({ tool: toolName, arguments: sanitized }, null, 2);
    const attempts: ManifestInvocationAttempt[] = [
        {
            label: 'mcp.call',
            args: ['mcp', 'call', toolName],
            stdin: jsonPayload,
            timeoutMs: manifestToolTimeoutMs
        }
    ];

    const segments = toolName.split('.');
    if (segments.length >= 2) {
        const category = segments[0];
        const action = segments
            .slice(1)
            .map((segment) => toKebabCase(segment))
            .join('-');
        const flagArgs = manifestArgsToFlags(sanitized);
        attempts.push({
            label: 'category-command',
            args: [category, action, ...flagArgs],
            stdin: JSON.stringify(sanitized, null, 2),
            timeoutMs: manifestToolTimeoutMs
        });
    }

    return attempts;
}

const manifestSchema = z
    .object({
        version: z.string().optional(),
        name: z.string().optional(),
        description: z.string().optional(),
        tools: z
            .array(
                z
                    .object({
                        name: z.string().trim().min(1, 'Tool name is required'),
                        title: z.string().optional(),
                        description: z.string().optional(),
                        arguments: z.unknown().optional(),
                        returns: z.unknown().optional(),
                        metadata: z.record(z.unknown()).optional()
                    })
                    .passthrough()
            )
            .optional(),
        resources: z.array(z.unknown()).optional()
    })
    .passthrough();

export async function loadMcpManifest(options: {
    workspaceRoot: string;
    server: any;
    runGeminiCliCommand: (args: string[], opts?: { stdin?: string; timeoutMs?: number }) => Promise<{ stdout: string; stderr: string }>;
    ensureCliReady: () => void;
    manifestToolTimeoutMs: number;
}) {
    const { workspaceRoot, server, runGeminiCliCommand, ensureCliReady, manifestToolTimeoutMs } = options;
    try {
        const manifestPath = path.join(workspaceRoot, 'mcp.json');
        try {
            await fs.access(manifestPath);
        } catch {
            logger.info('manifest: not found', { manifestPath });
            return;
        }
        const raw = await fs.readFile(manifestPath, 'utf8');
        const manifest = JSON.parse(raw) as any;
        const manifestValidation = manifestSchema.safeParse(manifest);
        if (!manifestValidation.success) {
            logger.error('manifest: validation failed; proceeding with raw manifest', {
                issues: manifestValidation.error.issues
            });
        }
        const manifestData = manifestValidation.success ? manifestValidation.data : manifest;
        const toolEntries = Array.isArray(manifestData.tools) ? manifestData.tools : [];
        logger.info('manifest: loaded', { toolCount: toolEntries.length });
        try {
            (server as any)._mcpManifest = manifestData;
        } catch { /* ignore */ }

        const manifestDir = path.dirname(manifestPath);
        const externalCache: Record<string, any> = {};
        const advertisedTools: string[] = [];
        for (const t of toolEntries) {
            try {
                if (!t || typeof t !== 'object') {
                    logger.warn('manifest: skipping entry with invalid structure', { entry: t });
                    continue;
                }
                if (typeof t.name !== 'string' || t.name.trim().length === 0) {
                    logger.warn('manifest: skipping entry without a valid name', { entry: t });
                    continue;
                }
                const toolName = t.name.trim();
                const hasTool = (server as any).hasTool?.(toolName) ?? Boolean((server as any)._tools && (server as any)._tools[toolName]);
                if (hasTool) {
                    continue;
                }

                let resolvedArgs: any = undefined;
                try {
                    if (t.arguments) {
                        resolvedArgs = await dereferenceSchema(t.arguments, manifestData, manifestDir, externalCache);
                    }
                } catch (refErr) {
                    logger.warn('manifest: failed to dereference schema', {
                        toolName,
                        error: String(refErr)
                    });
                    resolvedArgs = t.arguments;
                }
                const inputSchemaZod = resolvedArgs ? jsonSchemaToZod(resolvedArgs) : z.any().optional();

                try {
                    server.registerTool(
                        toolName,
                        {
                            title: t.title ?? toolName,
                            description: t.description ?? '',
                            inputSchema: inputSchemaZod
                        },
                        async (input: any, _extra: any) => {
                            try {
                                ensureCliReady();
                                const normalized = sanitizeManifestArgs(toolName, input ?? {}, workspaceRoot);
                                const result = await invokeManifestTool(toolName, normalized, runGeminiCliCommand, manifestToolTimeoutMs);
                                return { content: [{ type: 'text' as const, text: typeof result === 'string' ? result : JSON.stringify(result, null, 2) }] };
                            } catch (err) {
                                return { content: [{ type: 'text' as const, text: JSON.stringify({ error: serializeErrorForClient(err) }) }] };
                            }
                        }
                    );
                    logger.info('manifest: registered tool', { toolName });
                    try {
                        const title = (t.title && String(t.title).trim().length > 0) ? String(t.title) : undefined;
                        const desc = (t.description && String(t.description).trim().length > 0) ? String(t.description) : undefined;
                        const extra = title ? ` title="${title}"` : '';
                        const extraDesc = desc ? ` description="${desc}"` : '';
                        logger.info(`manifest: tool registered: ${toolName}${extra}${extraDesc}`);
                    } catch {
                        // ignore
                    }
                    advertisedTools.push(toolName);
                } catch (regErr: any) {
                    const msg = String((regErr && regErr.message) || regErr);
                    if (msg.toLowerCase().includes('already registered') || msg.toLowerCase().includes('already exists')) {
                        logger.info('manifest: skipped duplicate tool', { toolName });
                    } else {
                        logger.warn('manifest: failed to register tool', {
                            toolName,
                            error: String(regErr)
                        });
                    }
                }
            } catch (err) {
                const fallbackName = (t && typeof t === 'object' && 'name' in t) ? (t as any).name : '<unknown>';
                logger.warn('manifest: failed to register tool', {
                    toolName: fallbackName,
                    error: String(err)
                });
            }
        }
        if (advertisedTools.length > 0) {
            logger.info('manifest: tools available', { tools: advertisedTools });
        } else {
            logger.warn('manifest: no tools registered from manifest');
        }
    } catch (err) {
        logger.error('manifest: failed to load mcp.json', String(err));
    }
}

function sanitizeManifestArgs(toolName: string, rawInput: Record<string, unknown>, workspaceRoot: string) {
    const input: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(rawInput ?? {})) {
        if (value === undefined || value === null) {
            continue;
        }
        input[key] = value;
    }

    if (toolName === 'dev.summarizeCode') {
        const inputType = typeof input.inputType === 'string' ? String(input.inputType) : 'path';
        input.inputType = inputType;
            if (inputType === 'path') {
                const relPath = typeof input.path === 'string' ? input.path : undefined;
                if (!relPath) {
                    throw new Error('`path` is required when `inputType` is `path`.');
                }
                input.path = resolveWorkspacePath(relPath, workspaceRoot);
                delete input.content;
            } else if (inputType === 'text') {
                if (typeof input.content !== 'string' || input.content.trim().length === 0) {
                    throw new Error('`content` must be provided when `inputType` is `text`.');
                }
                delete input.path;
            }
        } else if (typeof input.path === 'string') {
            input.path = resolveWorkspacePath(String(input.path), workspaceRoot);
        }

    return input;
}

function resolveWorkspacePath(file: string, workspaceRoot: string) {
    const resolved = path.resolve(workspaceRoot, file);
    return assertPathWithinWorkspace(resolved, workspaceRoot);
}

function assertPathWithinWorkspace(target: string, workspaceRoot: string) {
    const normalizedTarget = normalizeForComparison(path.normalize(target));
    const normalizedRoot = normalizeForComparison(path.normalize(workspaceRoot));
    const prefix = normalizedRoot.endsWith(path.sep) ? normalizedRoot : normalizedRoot + path.sep;
    if (normalizedTarget === normalizedRoot || normalizedTarget.startsWith(prefix)) {
        return path.normalize(target);
    }
    throw new Error('File path is outside the allowed workspace directory.');
}

async function invokeManifestTool(toolName: string, args: Record<string, unknown>, runGeminiCliCommand: (args: string[], opts?: { stdin?: string; timeoutMs?: number }) => Promise<{ stdout: string; stderr: string }>, manifestToolTimeoutMs: number) {
    const attempts = buildManifestInvocationAttempts(toolName, args, manifestToolTimeoutMs);
    const errors: string[] = [];
    for (const attempt of attempts) {
        try {
            logger.info('manifest: invoking tool', {
                toolName,
                attempt: attempt.label,
                args: attempt.args,
                stdinBytes: attempt.stdin ? attempt.stdin.length : 0
            });
            const { stdout } = await runGeminiCliCommand(attempt.args, { stdin: attempt.stdin, timeoutMs: attempt.timeoutMs });
            const trimmed = stdout.trim();
            if (!trimmed) {
                logger.warn('manifest: tool returned empty output', {
                    toolName,
                    attempt: attempt.label
                });
                errors.push(`${attempt.label}: empty output`);
                continue;
            }
            try {
                logger.info('manifest: tool produced JSON output', {
                    toolName,
                    attempt: attempt.label,
                    bytes: Buffer.byteLength(trimmed, 'utf8')
                });
                return JSON.parse(trimmed);
            } catch {
                logger.info('manifest: tool produced text output', {
                    toolName,
                    attempt: attempt.label,
                    bytes: Buffer.byteLength(trimmed, 'utf8')
                });
                return trimmed;
            }
        } catch (error) {
            logger.warn('manifest: tool invocation failed', {
                toolName,
                attempt: attempt.label,
                error: formatWorkspaceError(error)
            });
            errors.push(`${attempt.label}: ${formatWorkspaceError(error)}`);
        }
    }
    throw new Error(errors.join('; '));
}
