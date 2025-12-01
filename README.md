# Gemini CLI MCP Extension

Bring Gemini CLI automations to GitHub Copilot inside VS Code. This extension exposes a local MCP stdio server that Copilot (or any MCP-aware client) can call to run long-running Gemini tasks such as linting, formatting, repo analysis, or end-to-end test runs. Every task is tracked, logged, and surfaced in the editor so you always know when Copilot is busy on your behalf.

## Requirements

- Node.js 18+ (MCP server runtime).
- Gemini CLI installed locally and accessible through `gemini` or a fully qualified path.
- A VS Code workspace folder or an explicit absolute `geminiMcp.taskCwd` path; the server refuses to run against the extension’s installation directory.

## How the Extension Runs

- Activation: the MCP server is registered as soon as VS Code finishes loading and a workspace (or configured `taskCwd`) exists.
- Triggering: Copilot invokes Gemini tools automatically when it needs help. No extra confirmation prompts are shown because all calls originate from your local Copilot session.
- Visibility: a status-bar item and the **Gemini CLI MCP Tasks** view show running/queued counts, last log lines, and duration. Selecting a task opens `tasks://{id}/log`.
- Safety: if the CLI fails validation (missing binary, quota exhausted, etc.), Copilot calls are rejected until you fix the issue and reload VS Code.

## Key Features

- Local MCP stdio server (`server/dist/index.js`) with concurrency control via a worker pool.
- Persistent task tracking under `.vscode/gemini-mcp/` (metadata, live status snapshots, rotating logs).
- Quick commands: `Gemini CLI MCP: Show Worker Status` and `Gemini CLI MCP: Open Task Log`.
- All worker limits, queue settings, and default priorities are configurable via VS Code settings or environment variables.

## Configuration in VS Code (`geminiMcp.*`)

| Setting | Description |
| --- | --- |
| `geminiPath` | Absolute path or PATH-resolvable Gemini CLI command (default `gemini`). |
| `maxWorkers` | Maximum concurrent Gemini processes (default `3`). |
| `taskCwd` | Working directory for spawned tasks (supports `${workspaceFolder}`); must be absolute if no workspace is open. |
| `maxQueue` | Queue size before new tasks are rejected (default `200`). |
| `modelBridge.*` | Settings that control the optional local automation bridge (stdio/socket). |

Changing any of these settings reloads the MCP provider and refreshes the worker status view.

### Model Automation Bridge

- `geminiMcp.modelBridge.stdioPath` (platform-dependent default): optional path for the local stdio/socket listener; when unset a workspace-derived socket path is used.
- `geminiMcp.modelBridge.allowedTools`: whitelist of MCP tools that automation callers may invoke; leave empty to allow all tools discovered from the workspace `mcp.json` manifest.
- `geminiMcp.modelBridge.allowOrchestrator` (default `true`): when `true`, the bridge also allows orchestrator requests so the orchestrated review workflow can be triggered programmatically.
- `geminiMcp.modelBridge.requestTimeoutMs` (default `120000`): per-request timeout (ms) for proxied MCP tool calls; requests exceeding this will be canceled and return a timeout response.
- `geminiMcp.modelBridge.captureSdkMessageId` (default `bestEffort`): how the extension captures SDK-assigned message ids for observability (`sdkHook` | `bestEffort` | `disabled`).


The bridge gives Copilot-style agents the same model/tool surface that the extension already exposes via `geminiMcp.orchestrateReview` and `geminiMcp.invokeTool`. The current implementation is a local stdio/socket bridge rather than an HTTP server, and it is intended for use by trusted local agents.

## Environment Variables (Server Side)

Use these when launching VS Code or wrapping `code` in a script (e.g., `.envrc`, shell profile):

- `GEMINI_CLI`, `GEMINI_MAX_WORKERS`, `GEMINI_TASK_CWD`, `GEMINI_MAX_QUEUE`
- `GEMINI_TIMEOUT_MANIFEST`

The server validates that `GEMINI_TASK_CWD` (or the resolved workspace root) lives inside a workspace folder, your home directory, or the OS temp directory.

## MCP Surface

Developer helper tools (code intelligence and transformation):
- `dev.summarizeCode` — summarize a source file or snippet (3-5 sentences / bullet points).
- `dev.explainSnippet` — provide a step-by-step / line-by-line explanation of a code snippet.
- `dev.generateComments` — generate detailed inline and header comments for provided code.
- `dev.refactorCode` — refactor code according to a specified goal, returning refactored code or a diff.
- `dev.extractInterface` — extract/infer an interface or type definition from implementation code.
- `dev.generateTests` — generate unit tests targeting a specified framework.
- `dev.translateCode` — translate code between languages while preserving functionality.

Web lookup tools (search external references and examples):
- `web.findCodeExample` — search the public web for code examples matching a feature or API query (returns snippets and links).
- `web.findLibraryUsage` — search for documentation, usage examples and API references for a given library/component/plugin.

- Resources: `tasks://{id}/log`, `tasks://{id}/summary`
  
All responses include `logUri` pointers so Copilot (or you) can stream output inside VS Code.

## Logs & Retention

- Task metadata: `.vscode/gemini-mcp/tasks.json`
- Live status snapshot: `.vscode/gemini-mcp/status.json`
- Logs: `.vscode/gemini-mcp/logs/{taskId}.log`
- Cleanup: completed tasks older than 7 days are pruned automatically.

## Notes

- Allowed working directories: workspace folders, your home directory, or the OS temp directory. Anything else is rejected.
- If Gemini CLI health transitions to `missing`, `quota_exhausted`, or `error`, reload VS Code (which restarts the MCP server) after fixing the underlying issue; the server does not automatically retry those states.
