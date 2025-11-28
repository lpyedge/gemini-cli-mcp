# Gemini CLI MCP Extension

Bring Gemini CLI automations to GitHub Copilot inside VS Code. This extension exposes a local MCP stdio server that Copilot (or any MCP-aware client) can call to run long-running Gemini tasks such as linting, formatting, repo analysis, or end-to-end test runs. Every task is tracked, logged, and surfaced in the editor so you always know when Copilot is busy on your behalf.

## Requirements

- Node.js 18+ (MCP server runtime).
- Gemini CLI installed locally and accessible through `gemini` or a fully qualified path.
- A VS Code workspace folder or an explicit absolute `geminiMcp.taskCwd` path; the server refuses to run against the extension’s installation directory.

## How the Extension Runs

- Activation: the MCP server is registered as soon as VS Code finishes loading and a workspace (or configured `taskCwd`) exists.
- Triggering: Copilot invokes Gemini tools automatically when it needs help (for example, when you accept a fix that requires running `tests.run` or `code.format.batch`). No extra confirmation prompts are shown because all calls originate from your local Copilot session.
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
| `defaultTimeouts.testsRun/codeAnalyze/codeFormat/taskSubmit` | Per-tool default timeouts in ms (`0` = no limit). |
| `defaultPriorities.testsRun/codeAnalyze/codeFormat/taskSubmit` | Per-tool queue priority from `-5` (low) to `5` (high). |

Changing any of these settings reloads the MCP provider and refreshes the worker status view.

## Environment Variables (Server Side)

Use these when launching VS Code or wrapping `code` in a script (e.g., `.envrc`, shell profile):

- `GEMINI_CLI`, `GEMINI_MAX_WORKERS`, `GEMINI_TASK_CWD`, `GEMINI_MAX_QUEUE`
- `GEMINI_TIMEOUT_TESTS_RUN`, `GEMINI_TIMEOUT_CODE_ANALYZE`, `GEMINI_TIMEOUT_CODE_FORMAT`, `GEMINI_TIMEOUT_TASK_SUBMIT`
- `GEMINI_PRIORITY_TESTS_RUN`, `GEMINI_PRIORITY_CODE_ANALYZE`, `GEMINI_PRIORITY_CODE_FORMAT`, `GEMINI_PRIORITY_TASK_SUBMIT`

The server validates that `GEMINI_TASK_CWD` (or the resolved workspace root) lives inside a workspace folder, your home directory, or the OS temp directory.

## MCP Surface

- Orchestration: `gemini.task.submit`, `gemini.task.status`, `gemini.task.list`, `gemini.task.tail`, `gemini.task.cancel`, `gemini.task.prune`
- Automation hints: `gemini.task.suggest`
- File helpers: `fs.read`, `fs.write`
- High-level tools: `code.analyze`, `code.format.batch`, `tests.run`
- Resources: `tasks://{id}/log`, `tasks://{id}/summary`

All responses include `logUri` pointers so Copilot (or you) can stream output inside VS Code.

## Logs & Retention

- Task metadata: `.vscode/gemini-mcp/tasks.json`
- Live status snapshot: `.vscode/gemini-mcp/status.json`
- Logs: `.vscode/gemini-mcp/logs/{taskId}.log`
- Cleanup: completed tasks older than 7 days are pruned automatically, or immediately via `gemini.task.prune`.

## Notes

- Allowed working directories: workspace folders, your home directory, or the OS temp directory. Anything else is rejected.
- If Gemini CLI health transitions to `missing`, `quota_exhausted`, or `error`, reload VS Code (which restarts the MCP server) after fixing the underlying issue; the server does not automatically retry those states.
