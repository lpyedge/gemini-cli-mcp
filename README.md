# Gemini CLI MCP Extension

GitHub Copilot can launch long‑running Gemini CLI jobs (analysis, linting, formatting, tests, etc.) through MCP. This extension registers a local MCP stdio server that exposes Gemini CLI helpers with task tracking, logging, and a VS Code status surface.

## Features

- Starts an MCP stdio server (`server/dist/index.js`) when VS Code loads and runs Gemini CLI jobs concurrently according to your worker settings.
- Persists every job to `.vscode/gemini-mcp/tasks.json`, streams logs to `.vscode/gemini-mcp/logs/{taskId}.log`, and writes live status snapshots to `.vscode/gemini-mcp/status.json`.
- Adds a status‑bar item plus the **Gemini CLI MCP Tasks** tree view showing running/queued counts, last log line, and duration with quick links to `tasks://{id}/log`.
- Queue limits, worker counts, timeouts, and priorities can be configured in VS Code settings or overridden with environment variables.

## Installation

```bash
npm install
npm run compile              # build extension + server bundles
# optional VSIX packaging
npm run package
code --install-extension dist/gemini-cli-mcp.vsix
# uninstall
code --uninstall-extension lpyedge.gemini-cli-mcp
```

## VS Code Settings (prefix `geminiMcp.`)

- `geminiPath`: absolute or PATH‑resolvable Gemini CLI command (default `gemini`).
- `maxWorkers`: maximum concurrent Gemini CLI processes (default `3`).
- `taskCwd`: working directory for tasks, supports `${workspaceFolder}` (default first workspace).
- `maxQueue`: maximum queued tasks before rejecting new submissions (default `200`).
- `defaultTimeouts.*`: per‑tool default timeouts in milliseconds (`0` = infinite).
- `defaultPriorities.*`: per‑tool queue priority, range `-5..5`.

The status bar and tree view watch `.vscode/gemini-mcp/status.json` in every workspace folder. If `taskCwd` is outside the workspace, the extra path is also monitored.

## Server Environment Variables

- `GEMINI_CLI`, `GEMINI_MAX_WORKERS`, `GEMINI_TASK_CWD`, `GEMINI_MAX_QUEUE`
- `GEMINI_TIMEOUT_TESTS_RUN`, `GEMINI_TIMEOUT_CODE_ANALYZE`, `GEMINI_TIMEOUT_CODE_FORMAT`, `GEMINI_TIMEOUT_TASK_SUBMIT`
- `GEMINI_PRIORITY_TESTS_RUN`, `GEMINI_PRIORITY_CODE_ANALYZE`, `GEMINI_PRIORITY_CODE_FORMAT`, `GEMINI_PRIORITY_TASK_SUBMIT`

## MCP Tools

- `gemini.task.submit`: run arbitrary Gemini CLI commands with optional `stdin`, `timeoutMs`, `priority`.
- `gemini.task.status`, `gemini.task.list`, `gemini.task.tail`, `gemini.task.cancel`, `gemini.task.prune`.
- `fs.read`, `fs.write`
- `code.analyze`, `code.format.batch`
- `tests.run`
- Resources: `tasks://{id}/log`, `tasks://{id}/summary`

## Logs & Retention

- Task metadata: `.vscode/gemini-mcp/tasks.json`
- Live status: `.vscode/gemini-mcp/status.json`
- Task logs: `.vscode/gemini-mcp/logs/{taskId}.log`
- Completed tasks/logs are pruned after 7 days (or via `gemini.task.prune`).

## Smoke Test

```bash
node scripts/mcpSmokeTest.mjs
```

The script launches the MCP server, runs `--version`/`--help`, exercises fs helpers, lists tasks, and tails logs.

## Release & Publish

- Create or update the tag on `main` you want to ship (e.g. `git tag v0.2.1 && git push origin v0.2.1`).
- Configure the `VSCE_TOKEN` repository secret with a VS Code Marketplace Personal Access Token that has `Publish` scope.
- Trigger the **Publish VS Code Extension** workflow in GitHub Actions, provide the tag input, and wait for it to finish.
- The workflow installs dependencies, runs `npm run package`, uploads the generated `dist/gemini-cli-mcp.vsix` artifact, and publishes the VSIX via `vsce publish`.

## Notes

- Allowed working directories: workspace folders, user home, or the system temp directory (others are rejected). Make sure `taskCwd` points to a safe location.
- On Windows, `.cmd/.bat` Gemini wrappers run through `cmd.exe /c` automatically.
