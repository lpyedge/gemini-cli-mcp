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
 * 建構自然語言風格的 prompt，讓 Gemini CLI 執行指定的任務。
 * 
 * 設計原則：
 * 1. 直接、具體的請求，避免角色扮演或系統指令
 * 2. 將參數自然地嵌入請求中
 * 3. 明確的輸出格式要求
 * 4. 針對不同工具類型提供適當的範例
 */
function buildToolExecutionPrompt(
    toolName: string,
    args: Record<string, unknown>,
    toolDescription?: string,
    _inputSchema?: unknown,
    outputSchema?: unknown
): string {
    const lines: string[] = [];
    
    // 根據工具類型建構具體的請求
    switch (toolName) {
        case 'web.findLibraryUsage': {
            const pkg = typeof args.packageName === 'string' ? args.packageName : '';
            const query = typeof args.query === 'string' ? args.query : '';
            const maxResults = typeof args.maxResults === 'number' ? args.maxResults : 10;
            
            lines.push(`Search the web for documentation and usage examples of the npm package "${pkg}".`);
            if (query) lines.push(`Focus on: ${query}`);
            lines.push('');
            lines.push(`Find up to ${maxResults} relevant results including official docs, tutorials, and API references.`);
            lines.push('');
            lines.push('Return a JSON object like this:');
            lines.push(`{"package":"${pkg}","matches":[{"title":"...", "summary":"...", "url":"https://...", "kind":"docs|example|api|tutorial"}]}`);
            break;
        }
        
        case 'web.findCodeExample': {
            const query = typeof args.query === 'string' ? args.query : '';
            const language = typeof args.language === 'string' ? args.language : '';
            const maxResults = typeof args.maxResults === 'number' ? args.maxResults : 5;
            
            lines.push(`Search the web for code examples that show how to: ${query}`);
            if (language) lines.push(`Preferred language: ${language}`);
            lines.push('');
            lines.push(`Find up to ${maxResults} code examples from GitHub, StackOverflow, or documentation sites.`);
            lines.push('');
            lines.push('Return a JSON object like this:');
            lines.push('{"results":[{"title":"...", "snippet":"// code here", "url":"https://...", "source":"GitHub|StackOverflow|..."}]}');
            break;
        }
        
        case 'dev.summarizeCode': {
            const content = typeof args.content === 'string' ? args.content : '';
            const filePath = typeof args.path === 'string' ? args.path : '';
            
            if (filePath) {
                lines.push(`Summarize the code in file: ${filePath}`);
            } else if (content) {
                lines.push('Summarize this code:');
                lines.push('```');
                lines.push(content.slice(0, 3000)); // 限制長度
                lines.push('```');
            }
            lines.push('');
            lines.push('Provide a concise summary in 3-5 sentences covering the main purpose and key functionality.');
            lines.push('');
            lines.push('Return: {"summary":"..."}');
            break;
        }
        
        case 'dev.explainSnippet': {
            const content = typeof args.content === 'string' ? args.content : '';
            const language = typeof args.language === 'string' ? args.language : '';
            
            lines.push('Explain this code step by step:');
            lines.push(`\`\`\`${language}`);
            lines.push(content.slice(0, 3000));
            lines.push('```');
            lines.push('');
            lines.push('Return: {"explanation":"..."}');
            break;
        }
        
        case 'dev.generateComments': {
            const content = typeof args.content === 'string' ? args.content : '';
            const language = typeof args.language === 'string' ? args.language : '';
            const style = typeof args.style === 'string' ? args.style : 'detailed';
            
            lines.push(`Add ${style} comments to this ${language || ''} code:`);
            lines.push('```');
            lines.push(content.slice(0, 3000));
            lines.push('```');
            lines.push('');
            lines.push('Include header comments and inline explanations. Return: {"commentedCode":"..."}');
            break;
        }
        
        case 'dev.refactorCode': {
            const content = typeof args.content === 'string' ? args.content : '';
            const goal = typeof args.goal === 'string' ? args.goal : 'improve readability';
            
            lines.push(`Refactor this code to ${goal}:`);
            lines.push('```');
            lines.push(content.slice(0, 3000));
            lines.push('```');
            lines.push('');
            lines.push('Return: {"refactored":"...", "diff":"optional diff showing changes"}');
            break;
        }
        
        case 'dev.extractInterface': {
            const content = typeof args.content === 'string' ? args.content : '';
            const target = typeof args.target === 'string' ? args.target : 'TypeScript';
            
            lines.push(`Extract a ${target} interface/type from this implementation:`);
            lines.push('```');
            lines.push(content.slice(0, 3000));
            lines.push('```');
            lines.push('');
            lines.push('Return: {"interface":"..."}');
            break;
        }
        
        case 'dev.generateTests': {
            const content = typeof args.content === 'string' ? args.content : '';
            const framework = typeof args.framework === 'string' ? args.framework : 'jest';
            const language = typeof args.language === 'string' ? args.language : '';
            
            lines.push(`Generate ${framework} unit tests for this ${language || ''} code:`);
            lines.push('```');
            lines.push(content.slice(0, 3000));
            lines.push('```');
            lines.push('');
            lines.push('Include edge cases and assertions. Return: {"tests":"..."}');
            break;
        }
        
        case 'dev.translateCode': {
            const content = typeof args.content === 'string' ? args.content : '';
            const targetLanguage = typeof args.targetLanguage === 'string' ? args.targetLanguage : '';
            const includeNotes = args.notes === true;
            
            lines.push(`Translate this code to ${targetLanguage}:`);
            lines.push('```');
            lines.push(content.slice(0, 3000));
            lines.push('```');
            lines.push('');
            if (includeNotes) {
                lines.push('Include notes about any non-trivial translations. Return: {"translated":"...", "notes":"..."}');
            } else {
                lines.push('Return: {"translated":"..."}');
            }
            break;
        }
        
        default: {
            // 通用處理：使用 mcp.json 的 description 或構造基本請求
            const desc = toolDescription?.trim();
            if (desc) {
                lines.push(desc);
            } else {
                lines.push(`Execute tool "${toolName}" with the provided parameters.`);
            }
            lines.push('');
            lines.push('Parameters:');
            lines.push(JSON.stringify(args ?? {}, null, 2));
            lines.push('');
            
            // 使用 mcp.json 定義的 outputSchema（如果有）
            if (outputSchema) {
                const schemaStr = typeof outputSchema === 'string' 
                    ? outputSchema 
                    : JSON.stringify(outputSchema, null, 2);
                lines.push('Return a JSON object matching this schema:');
                lines.push(schemaStr);
            } else {
                lines.push('Return the result as a JSON object.');
            }
            break;
        }
    }
    
    // 通用的輸出格式提醒
    lines.push('');
    lines.push('IMPORTANT: Return ONLY valid JSON. No markdown formatting, no extra text.');
    
    return lines.join('\n');
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
