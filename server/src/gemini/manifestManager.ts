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
    manifestToolTimeoutMs: number;
}) {
    const { workspaceRoot, server, runGeminiCliCommand, manifestToolTimeoutMs } = options;
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
                            // Log that the manifest tool was invoked, even if it later fails.
                            try {
                                const summary = (input && typeof input === 'object') ? { keys: Object.keys(input).slice(0, 10) } : undefined;
                                logger.info('manifest: tool invocation requested', { toolName, inputSummary: summary });
                            } catch {}

                            try {
                                const normalized = sanitizeManifestArgs(toolName, input ?? {}, workspaceRoot);
                                // 傳遞完整的工具元資料，包括 schema 資訊
                                const toolMeta = {
                                    description: t.description,
                                    inputSchema: resolvedArgs,      // 已解析的輸入 schema
                                    outputSchema: t.returns         // mcp.json 中定義的輸出 schema
                                };
                                const result = await invokeManifestTool(toolName, normalized, runGeminiCliCommand, manifestToolTimeoutMs, toolMeta);
                                return { content: [{ type: 'text' as const, text: typeof result === 'string' ? result : JSON.stringify(result, null, 2) }] };
                            } catch (err) {
                                try {
                                    logger.warn('manifest: tool invocation failed', { toolName, error: String(err), message: formatWorkspaceError(err) });
                                } catch {}
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

/**
 * 工具專屬的任務指引與輸出格式說明。
 * 這些指引會嵌入到 prompt 中，幫助 Gemini CLI 理解每個工具的具體行為。
 */
function buildToolGuidance(toolName: string, args: Record<string, unknown>): { task: string; outputSchema: string; examples?: string } {
    switch (toolName) {
        case 'web.findLibraryUsage': {
            const pkg = typeof args.packageName === 'string' ? args.packageName : '<package>';
            return {
                task: `Search the web for documentation, usage examples, and API references for the package "${pkg}".`,
                outputSchema: JSON.stringify({
                    type: 'object',
                    properties: {
                        package: { type: 'string', description: 'The package name searched' },
                        matches: {
                            type: 'array',
                            items: {
                                type: 'object',
                                properties: {
                                    title: { type: 'string' },
                                    summary: { type: 'string' },
                                    url: { type: 'string' },
                                    kind: { type: 'string', enum: ['docs', 'example', 'api', 'tutorial'] }
                                }
                            }
                        }
                    },
                    required: ['package', 'matches']
                }, null, 2),
                examples: `{"package":"${pkg}","matches":[{"title":"Official Docs","summary":"...","url":"https://...","kind":"docs"}]}`
            };
        }
        case 'web.findCodeExample': {
            return {
                task: 'Search the public web for code examples that implement the requested feature or API.',
                outputSchema: JSON.stringify({
                    type: 'object',
                    properties: {
                        results: {
                            type: 'array',
                            items: {
                                type: 'object',
                                properties: {
                                    title: { type: 'string' },
                                    snippet: { type: 'string', description: 'Code snippet if available' },
                                    url: { type: 'string' },
                                    source: { type: 'string', description: 'e.g. GitHub, StackOverflow' }
                                }
                            }
                        }
                    },
                    required: ['results']
                }, null, 2)
            };
        }
        case 'dev.summarizeCode': {
            return {
                task: 'Generate a concise summary (3-5 sentences or bullet points) of the provided code.',
                outputSchema: '{"type":"object","properties":{"summary":{"type":"string"}},"required":["summary"]}'
            };
        }
        case 'dev.explainSnippet': {
            return {
                task: 'Provide a step-by-step or line-by-line explanation of the code snippet.',
                outputSchema: '{"type":"object","properties":{"explanation":{"type":"string"}},"required":["explanation"]}'
            };
        }
        case 'dev.generateComments': {
            return {
                task: 'Insert detailed inline and/or header comments into the provided code.',
                outputSchema: '{"type":"object","properties":{"commentedCode":{"type":"string"}},"required":["commentedCode"]}'
            };
        }
        case 'dev.refactorCode': {
            return {
                task: 'Refactor the provided code according to the specified goal (e.g., split function, improve performance).',
                outputSchema: '{"type":"object","properties":{"refactored":{"type":"string"},"diff":{"type":"string"}},"required":["refactored"]}'
            };
        }
        case 'dev.extractInterface': {
            return {
                task: 'Infer and extract an interface or type definition from the provided implementation code.',
                outputSchema: '{"type":"object","properties":{"interface":{"type":"string"}},"required":["interface"]}'
            };
        }
        case 'dev.generateTests': {
            return {
                task: 'Generate unit tests for the provided code, targeting the specified test framework.',
                outputSchema: '{"type":"object","properties":{"tests":{"type":"string"}},"required":["tests"]}'
            };
        }
        case 'dev.translateCode': {
            return {
                task: 'Translate the provided code to the target programming language while preserving functionality.',
                outputSchema: '{"type":"object","properties":{"translated":{"type":"string"},"notes":{"type":"string"}},"required":["translated"]}'
            };
        }
        default:
            return {
                task: 'Execute the tool action using the provided arguments and return a structured result.',
                outputSchema: '{"type":"object","additionalProperties":true}'
            };
    }
}

/**
 * 建構完整的 prompt，用於讓 Gemini CLI 扮演指定的 MCP 工具角色。
 * 
 * Prompt 結構：
 * 1. System 角色設定：說明 CLI 正在代理執行 MCP 工具
 * 2. 工具定義：包含 description 和預期的輸入/輸出 schema
 * 3. 執行指令：強調立即執行、不問問題、只返回 JSON
 * 4. 輸入參數：主 AI 傳來的實際請求參數
 */
function buildToolExecutionPrompt(
    toolName: string,
    args: Record<string, unknown>,
    toolDescription?: string,
    inputSchema?: unknown,
    outputSchema?: unknown
): string {
    const argJson = JSON.stringify(args ?? {}, null, 2);
    const guidance = buildToolGuidance(toolName, args);
    
    // 優先使用 mcp.json 定義的 schema，否則用工具專屬的預設 schema
    const effectiveOutputSchema = outputSchema 
        ? (typeof outputSchema === 'string' ? outputSchema : JSON.stringify(outputSchema, null, 2))
        : guidance.outputSchema;
    
    const effectiveInputSchema = inputSchema
        ? (typeof inputSchema === 'string' ? inputSchema : JSON.stringify(inputSchema, null, 2))
        : null;

    const sections: string[] = [];

    // === Section 1: The Command (Task) ===
    const purpose = toolDescription?.trim() || guidance.task;
    sections.push(`Task: ${purpose}`);

    // === Section 2: The Input ===
    sections.push(`Input Variables:\n${argJson}`);

    // === Section 3: The Constraint (Output format) ===
    sections.push(`Instructions:
1. Process the input variables according to the task.
2. Output the result strictly as a valid JSON object.
3. Do not output any conversational text (e.g. "Okay", "Here is the result").
4. The output must match this JSON schema:
${effectiveOutputSchema}`);

    // === Section 4: Example ===
    if (guidance.examples) {
        sections.push(`Example Output:\n${guidance.examples}`);
    }

    return sections.join('\n\n');
}

// Legacy alias for backward compatibility (if needed elsewhere)
function buildPromptFallback(toolName: string, args: Record<string, unknown>, toolDescription?: string) {
    return buildToolExecutionPrompt(toolName, args, toolDescription);
}

/**
 * 調用 manifest 定義的工具。
 * 
 * 這個函數將主 AI 的工具調用請求轉換為一個結構化的 prompt，
 * 發送給 Gemini CLI 執行，並解析返回的 JSON 結果。
 * 
 * Gemini CLI headless 模式要點：
 * - 使用 `--prompt` 傳遞任務
 * - 使用 `--output-format json` 取得結構化輸出
 * - 使用 `--yolo` 自動核准所有操作（避免等待確認）
 * - 輸出格式為 `{ response: "...", stats: {...} }`，需從 `response` 提取結果
 * 
 * @param toolName - 工具名稱（如 "dev.summarizeCode"）
 * @param args - 主 AI 傳來的參數（已經過 sanitize）
 * @param runGeminiCliCommand - CLI 執行函數
 * @param manifestToolTimeoutMs - 超時設定
 * @param toolMeta - 工具元資料（description, inputSchema, outputSchema）
 */
async function invokeManifestTool(
    toolName: string,
    args: Record<string, unknown>,
    runGeminiCliCommand: (args: string[], opts?: { stdin?: string; timeoutMs?: number }) => Promise<{ stdout: string; stderr: string }>,
    manifestToolTimeoutMs: number,
    toolMeta?: {
        description?: string;
        inputSchema?: unknown;
        outputSchema?: unknown;
    }
) {
    try {
        // 建構結構化的 prompt，包含工具定義、schema、執行規則和輸入參數
        const prompt = buildToolExecutionPrompt(
            toolName,
            args,
            toolMeta?.description,
            toolMeta?.inputSchema,
            toolMeta?.outputSchema
        );
        
        logger.info('manifest: invoking via prompt execution', {
            toolName,
            promptBytes: Buffer.byteLength(prompt, 'utf8'),
            hasInputSchema: Boolean(toolMeta?.inputSchema),
            hasOutputSchema: Boolean(toolMeta?.outputSchema)
        });

        // Gemini CLI headless 模式：
        // - --prompt: 傳遞任務
        // - --output-format json: 取得結構化輸出 { response, stats, error? }
        // - --yolo: 自動核准所有操作，避免等待確認而進入對話模式
        const { stdout, stderr } = await runGeminiCliCommand(
            ['--prompt', prompt, '--output-format', 'json', '--yolo'],
            { timeoutMs: manifestToolTimeoutMs }
        );

        // 記錄 stderr（如果有）以便除錯
        if (stderr && stderr.trim()) {
            logger.warn('manifest: CLI stderr output', { toolName, stderr: stderr.slice(0, 500) });
        }

        const trimmed = stdout.trim();
        if (!trimmed) {
            throw new Error('prompt: empty output from CLI');
        }

        // 解析 Gemini CLI 的 JSON 輸出
        // 結構為: { response: string, stats: {...}, error?: {...} }
        try {
            const cliOutput = JSON.parse(trimmed);
            logger.info('manifest: CLI produced JSON output', {
                toolName,
                bytes: Buffer.byteLength(trimmed, 'utf8'),
                hasResponse: Boolean(cliOutput?.response),
                hasError: Boolean(cliOutput?.error)
            });
            
            // 檢查 CLI 是否返回了錯誤
            if (cliOutput && typeof cliOutput === 'object' && cliOutput.error) {
                const errorMsg = cliOutput.error.message || JSON.stringify(cliOutput.error);
                logger.warn('manifest: CLI returned error', { toolName, error: errorMsg });
                throw new Error(`CLI error: ${errorMsg}`);
            }

            // 從 response 欄位提取實際回應
            const responseText = cliOutput?.response;
            if (typeof responseText !== 'string' || !responseText.trim()) {
                // 如果沒有 response 欄位，可能是舊版格式或直接輸出
                // 嘗試將整個輸出作為結果
                logger.info('manifest: no response field, using full output', { toolName });
                return cliOutput;
            }

            // 嘗試將 response 解析為 JSON（模型可能返回 JSON 字串）
            const responseTrimmed = responseText.trim();
            try {
                const parsed = JSON.parse(responseTrimmed);
                logger.info('manifest: response parsed as JSON', {
                    toolName,
                    keys: parsed && typeof parsed === 'object' ? Object.keys(parsed).slice(0, 5) : []
                });
                return parsed;
            } catch {
                // response 不是 JSON，嘗試提取 markdown 中的 JSON 區塊
                const jsonMatch = responseTrimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
                if (jsonMatch && jsonMatch[1]) {
                    try {
                        const extracted = JSON.parse(jsonMatch[1].trim());
                        logger.info('manifest: extracted JSON from markdown in response', { toolName });
                        return extracted;
                    } catch {
                        // 繼續使用原始文字
                    }
                }
                
                // response 是純文字，包裝為標準格式返回
                logger.info('manifest: response is plain text', {
                    toolName,
                    preview: responseTrimmed.slice(0, 100)
                });
                return { result: responseTrimmed };
            }
        } catch (parseErr) {
            // stdout 不是有效的 JSON
            logger.warn('manifest: failed to parse CLI output as JSON', {
                toolName,
                error: String(parseErr),
                preview: trimmed.slice(0, 200)
            });
            
            // 嘗試提取 JSON 區塊
            const jsonMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
            if (jsonMatch && jsonMatch[1]) {
                try {
                    const extracted = JSON.parse(jsonMatch[1].trim());
                    logger.info('manifest: extracted JSON from markdown block', { toolName });
                    return extracted;
                } catch {
                    // 繼續使用原始文字
                }
            }
            
            // 包裝為標準格式返回
            return { result: trimmed };
        }
    } catch (err) {
        throw new Error(`prompt-execution: ${formatWorkspaceError(err)}`);
    }
}
