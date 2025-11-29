import * as vscode from 'vscode';
import path from 'node:path';
import fs from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';

import { readConfig, resolveTaskCwd, clampPriority } from './extension/configUtils';
// 'os' not used in this module; removed to avoid unused import
import { GeminiCliHealth } from './extension/cliHealth';
import { GeminiTaskTreeProvider } from './extension/treeProvider';
import { TaskStatusMonitor } from './extension/statusMonitor';
import { runOrchestrator } from './extension/orchestrator';
import * as mcpClientModule from './extension/mcpClient';
import { ModelBridge } from './extension/modelBridge';

// The activate module wires the UI pieces together and registers the MCP provider
// and extension commands. It intentionally keeps the wiring logic concise and
// imports well-scoped modules for the implementation details.

async function buildMcpDefinitions(
	context: vscode.ExtensionContext,
	cfg: any,
	cliHealth: GeminiCliHealth,
	output: vscode.OutputChannel,
	initialHealthCheck: Promise<void>,
	providerTriggerCount: number
): Promise<vscode.McpServerDefinition[]> {
	await initialHealthCheck.catch(() => {});
	const servers: vscode.McpServerDefinition[] = [];

	// If CLI is unhealthy, return empty but log reason for diagnosis
	if (!cliHealth.isHealthy()) {
		output.appendLine('Gemini MCP: CLI not healthy; no MCP servers will be provided');
		return servers;
	}

	// Rely on GeminiCliHealth to validate the configured geminiPath and report status.
	// The health check will short-circuit if the binary is missing and will emit
	// `onDidChange` so the extension can react (log, UI prompts, etc.).
	// Ensure we at least initiated a health refresh for latest config.
	try {
		void cliHealth.refresh(cfg).catch(() => {});
	} catch (e) {
		output.appendLine(`Gemini MCP: failed to refresh cli health: ${String(e)}`);
	}

	// Prefer an absolute path to the bundled server entry. Relying on cwd+relative
	// args can fail if packaging/layout changes; use explicit path instead.
	const serverCwd = vscode.Uri.joinPath(context.extensionUri, 'server').fsPath;
	const serverEntry = vscode.Uri.joinPath(context.extensionUri, 'server', 'dist', 'index.js').fsPath;
	output.appendLine(`Gemini MCP: resolved serverEntry=${serverEntry}`);

	// If the bundled server entry is missing, avoid returning a server definition.
	if (!fs.existsSync(serverEntry)) {
		output.appendLine(`Gemini MCP: server entry not found: ${serverEntry}. Skipping MCP server registration.`);
		return servers;
	}

	// Resolve task cwd; if missing, prefer workspace root. If no workspace
	// is open, do NOT fall back to `process.cwd()` (which is the VS Code
	// install folder in Extension Development Host) — instead, avoid
	// returning a server definition so the host won't spawn a server with
	// an incorrect working directory.
	let resolvedTaskCwd = resolveTaskCwd(cfg.taskCwd);
	if (!resolvedTaskCwd) {
		const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
		if (workspaceRoot) {
			output.appendLine(`Gemini MCP: configured taskCwd not resolvable; falling back to workspace root ${workspaceRoot}`);
			resolvedTaskCwd = workspaceRoot;
		} else {
			output.appendLine('Gemini MCP: no workspace folder available and `taskCwd` not set or invalid. Skipping MCP server registration to avoid using VS Code install directory as taskCwd.');
			try {
				void vscode.window.showErrorMessage(
					'Gemini MCP: no workspace folder available and `geminiMcp.taskCwd` is not set. Please open a workspace or set `geminiMcp.taskCwd` to enable MCP servers.'
				);
			} catch (e) {
				// ignore UI errors in headless/test environments
			}
			return servers;
		}
	}

	// Use the extension host's Node executable when it is actually Node;
	// when running in the packaged VS Code build `process.execPath` is
	// often the Code executable (Code.exe) which will not run a plain JS
	// file. Prefer `node` in that case so the server is started by Node
	// available on PATH instead of attempting to execute Code.exe.
	let nodeBin = process.execPath || 'node';
	try {
		const execName = path.basename(String(nodeBin)).toLowerCase();
		if (!execName.includes('node')) {
			nodeBin = 'node';
		}
	} catch {
		nodeBin = 'node';
	}
	const args = [serverEntry];
	output.appendLine(`Gemini MCP: starting node executable=${nodeBin} args=${JSON.stringify(args)}`);

	// Merge process.env to preserve PATH and other runtime environment values
	const envVars: NodeJS.ProcessEnv = {
		...process.env,
		GEMINI_CLI: cfg.geminiPath,
		GEMINI_MAX_WORKERS: String(Math.max(1, cfg.maxWorkers)),
		GEMINI_TASK_CWD: resolvedTaskCwd,
		GEMINI_MAX_QUEUE: String(Math.max(1, cfg.maxQueue)),
		GEMINI_TIMEOUT_TESTS_RUN: String(Math.max(0, cfg.defaultTimeouts.testsRun)),
		GEMINI_TIMEOUT_CODE_ANALYZE: String(Math.max(0, cfg.defaultTimeouts.codeAnalyze)),
		GEMINI_TIMEOUT_CODE_FORMAT: String(Math.max(0, cfg.defaultTimeouts.codeFormat)),
		GEMINI_TIMEOUT_TASK_SUBMIT: String(Math.max(0, cfg.defaultTimeouts.taskSubmit)),
		GEMINI_PRIORITY_TESTS_RUN: String(clampPriority(cfg.defaultPriorities.testsRun)),
		GEMINI_PRIORITY_CODE_ANALYZE: String(clampPriority(cfg.defaultPriorities.codeAnalyze)),
		GEMINI_PRIORITY_CODE_FORMAT: String(clampPriority(cfg.defaultPriorities.codeFormat)),
		GEMINI_PRIORITY_TASK_SUBMIT: String(clampPriority(cfg.defaultPriorities.taskSubmit))
	};
	// For diagnostics, log only the GEMINI_* keys plus PATH to avoid dumping unrelated secrets
	try {
		const logged: Record<string, string | undefined> = {};
		Object.keys(envVars).forEach((k) => {
			if (k.startsWith('GEMINI_') || k === 'PATH') logged[k] = envVars[k];
		});
		output.appendLine(`Gemini MCP: env subset: ${JSON.stringify(logged)}`);
	} catch (e) {
		output.appendLine(`Gemini MCP: failed to stringify env for logging: ${String(e)}`);
	}

	try {
		// Read extension package.json to source the version dynamically for server definition
		let version = '1.0.0';
		try {
			const raw = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(context.extensionUri, 'package.json'));
			const parsed = JSON.parse(Buffer.from(raw).toString('utf8'));
			if (parsed && parsed.version) version = parsed.version;
		} catch (err) {
			output.appendLine(`Gemini MCP: failed to read package.json for version fallback: ${String(err)}`);
		}

		const sanitizedEnv: Record<string, string> = {};
		Object.keys(envVars).forEach((k) => {
			const v = envVars[k];
			if (v !== undefined && v !== null) sanitizedEnv[k] = String(v);
		});

		const def = new vscode.McpStdioServerDefinition(
			'gemini-cli-mcp',
			nodeBin,
			args,
			sanitizedEnv,
			version
		);
		// keep cwd set to server folder so relative modules/resources resolve
		def.cwd = vscode.Uri.file(serverCwd);
		servers.push(def);
	} catch (err) {
		output.appendLine(`Gemini MCP: failed to create MCP server definition ${String(err)}`);
	}

	return servers;
}

export function activate(context: vscode.ExtensionContext) {
	const statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
	statusItem.name = 'Gemini CLI MCP';
	statusItem.text = '$(hubot) Gemini';
	statusItem.tooltip = 'Copilot orchestrates local Gemini CLI workers via MCP';
	statusItem.show();
	context.subscriptions.push(statusItem);

	// Create an output channel for detailed diagnostics early so other
	// components (like GeminiCliHealth) can write diagnostic messages.
	const output = vscode.window.createOutputChannel('Gemini CLI MCP');
	context.subscriptions.push(output);

	const cliHealth = new GeminiCliHealth(output);
	context.subscriptions.push(cliHealth);

	// Log CLI health changes to the output channel for diagnostics
	context.subscriptions.push(cliHealth.onDidChange(() => {
		try {
			const s = cliHealth.getStatus();
			output.appendLine(`Gemini MCP: CLI health changed -> ${JSON.stringify(s)}`);
		} catch (e) {
			// swallow logging errors
		}
	}));

	const taskTreeProvider = new GeminiTaskTreeProvider();
	const treeRegistration = vscode.window.registerTreeDataProvider('geminiMcp.tasks', taskTreeProvider);
	context.subscriptions.push(treeRegistration);

	const statusMonitor = new TaskStatusMonitor(context, statusItem, taskTreeProvider, cliHealth);
	context.subscriptions.push(statusMonitor);

	const modelBridge = new ModelBridge(output);
	context.subscriptions.push(modelBridge);
	void modelBridge.start();

	const initialConfig = readConfig();
	const initialHealthCheck = cliHealth.refresh(initialConfig);

	const providerEmitter = new vscode.EventEmitter<void>();
	context.subscriptions.push(providerEmitter);

	// Track how often the provider is asked to provide definitions (helpful for diagnostics)
	let providerTriggerCount = 0;
	providerEmitter.event(() => {
		providerTriggerCount += 1;
		output.appendLine(`Gemini MCP: providerEmitter fired (${providerTriggerCount} times)`);
	});
	// NOTE: do not fire providerEmitter directly from cliHealth.onDidChange.
	// Firing the provider on every health change causes a feedback loop:
	// cliHealth.onDidChange -> providerEmitter.fire -> provideMcpServerDefinitions -> cliHealth.refresh
	// which leads to repeated refreshes and toggling of the health state.
	// The `TaskStatusMonitor` already receives `cliHealth` and will update UI; keep health-change
	// handling scoped to UI/diagnostics only.
	const workspaceWatcher = vscode.workspace.onDidChangeWorkspaceFolders(() => {
		providerEmitter.fire();
	});
	context.subscriptions.push(workspaceWatcher);

	const providerObj = {
		onDidChangeMcpServerDefinitions: providerEmitter.event,
		provideMcpServerDefinitions: async () => {
			output.appendLine(`Gemini MCP: provideMcpServerDefinitions called (#${providerTriggerCount + 1})`);
			await initialHealthCheck.catch(() => {});
			const cfg = readConfig();
			return buildMcpDefinitions(context, cfg, cliHealth, output, initialHealthCheck, providerTriggerCount);
		},
		resolveMcpServerDefinition: async (server: any) => server
	};

	// MCP host API can live under different namespaces depending on VS Code
	// version or proposed APIs. Feature-detect the provider registration API
	// rather than assuming `vscode.lm` exists to reduce strict engine bounds.
	const hostLm: any = (vscode as any).lm ?? (vscode as any).mcp ?? (vscode as any);
	if (hostLm && typeof hostLm.registerMcpServerDefinitionProvider === 'function') {
		const provider = hostLm.registerMcpServerDefinitionProvider('gemini-mcp-provider', providerObj);
		context.subscriptions.push(provider);
	} else if (typeof (vscode as any).registerMcpServerDefinitionProvider === 'function') {
		// some hosts might expose a top-level registration function
		const provider = (vscode as any).registerMcpServerDefinitionProvider('gemini-mcp-provider', providerObj);
		context.subscriptions.push(provider);
	} else {
		output.appendLine('Gemini MCP: host does not support MCP server provider registration API; installing no-op shim for compatibility.');
		try {
			const existing = (globalThis as any).__geminiLmShim ?? (vscode as any).mcp ?? undefined;
			if (!existing || !existing.registerMcpServerDefinitionProvider) {
				(globalThis as any).__geminiLmShim = {
					registerMcpServerDefinitionProvider: (id: string, provider: any) => {
						output.appendLine(`Gemini MCP: registered no-op MCP provider (shim) for ${id}`);
						return { dispose: () => output.appendLine(`Gemini MCP: disposed no-op MCP provider (shim) for ${id}`) };
					}
				};
				// Ensure we clean up shim on deactivate
				context.subscriptions.push({ dispose: () => { try { delete (globalThis as any).__geminiLmShim; } catch {} } });
			}
		} catch (e) {
			output.appendLine(`Gemini MCP: failed to install no-op shim: ${String(e)}`);
		}
	}

	const configWatcher = vscode.workspace.onDidChangeConfiguration((event) => {
		if (event.affectsConfiguration('geminiMcp')) {
			void modelBridge.restart();
			providerEmitter.fire();
			const cfg = readConfig();
			statusMonitor.updateConfig(cfg);
			// 當設定變更時也刷新 CLI Health，確保狀態與 config 同步
			void cliHealth.refresh(cfg).catch(() => {});
			void vscode.window
				.showWarningMessage(
					'Gemini CLI MCP settings changed. Reload VS Code to re-validate the Gemini CLI state.',
					'Reload',
					'Dismiss'
				)
				.then((choice) => {
					if (choice === 'Reload') {
						void vscode.commands.executeCommand('workbench.action.reloadWindow');
					}
				});
		}
	});
	context.subscriptions.push(configWatcher);
	// 發起一次 provider 更新以確保 provider 在 activation 後能被測試/載入
	providerEmitter.fire();

	const showStatusCmd = vscode.commands.registerCommand('geminiMcp.showStatus', async () => {
		await initialHealthCheck.catch(() => {});
		const cfg = readConfig();
		statusMonitor.updateConfig(cfg);
		const cliStatus = cliHealth.getStatus();
		const cliLabel =
			cliStatus.state === 'ok'
				? `OK (${cliStatus.message})`
				: `${cliStatus.state.toUpperCase()} (${cliStatus.message})`;
		vscode.window.showInformationMessage(
			`Gemini CLI MCP workers: ${cfg.maxWorkers}, CLI: ${cliLabel}`
		);
	});
	context.subscriptions.push(showStatusCmd);

	// Diagnose command: prints config and verifies resolved paths and files
	const diagnoseCmd = vscode.commands.registerCommand('geminiMcp.diagnose', async () => {
		await initialHealthCheck.catch(() => {});
		const cfg = readConfig();
		statusMonitor.updateConfig(cfg);
		const resolvedTaskCwd = resolveTaskCwd(cfg.taskCwd) || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || process.cwd();
		const serverEntry = path.join(context.extensionUri.fsPath, 'server', 'dist', 'index.js');
		const exists = fs.existsSync(serverEntry);
		output.show(true);
		output.appendLine('--- Gemini MCP diagnose ---');
		output.appendLine(`config: ${JSON.stringify(cfg)}`);
		output.appendLine(`resolvedTaskCwd: ${resolvedTaskCwd}`);
		output.appendLine(`serverEntry: ${serverEntry}`);
		output.appendLine(`serverEntry exists: ${exists}`);
		output.appendLine(`cliHealth: ${JSON.stringify(cliHealth.getStatus())}`);
		vscode.window.showInformationMessage('Gemini MCP: diagnosis written to Output -> "Gemini CLI MCP"');
	});
	context.subscriptions.push(diagnoseCmd);

	const orchestrateCmd = vscode.commands.registerCommand('geminiMcp.orchestrateReview', async () => {
		output.show(true);
		output.appendLine('Gemini MCP: starting orchestrated review...');
		try {
			const cfg = readConfig();
			await runOrchestrator(cfg, output);
			output.appendLine('Gemini MCP: orchestrated review finished.');
		} catch (err) {
			output.appendLine(`Orchestrator failed: ${String(err)}`);
		}
	});
	context.subscriptions.push(orchestrateCmd);

	const invokeCmd = vscode.commands.registerCommand('geminiMcp.invokeTool', async (toolName?: string, args?: any) => {
		output.show(true);
		const cfg = readConfig();
		try {
			if (!toolName) {
				const picks = [
					'gemini.task.submit',
					'gemini.task.status',
					'gemini.task.list',
					'gemini.task.tail',
					'gemini.task.cancel',
					'gemini.task.prune',
					'gemini.task.suggest',
					'fs.read',
					'fs.write',
					'code.analyze',
					'code.format.batch',
					'tests.run'
				];
				toolName = await vscode.window.showQuickPick(picks, { placeHolder: 'Select MCP tool to invoke' });
				if (!toolName) return;
			}
			if (!args) {
				const json = await vscode.window.showInputBox({ placeHolder: 'Enter tool arguments as JSON (or leave blank for defaults)' });
				if (json && json.trim().length) args = JSON.parse(json);
			}
			// Use orchestrator helper to run tool via MCP
			const mc = await mcpClientModule.getMcpClient(cfg, output);
			const client: any = mc.client;
			const res = await client.callTool({ name: toolName, arguments: args ?? {} });
			const first = res.content?.find((c: any) => c.type === 'text');
			if (first && first.text) {
				output.appendLine(`Tool ${toolName} -> ${first.text}`);
			} else {
				output.appendLine(`Tool ${toolName} -> ${JSON.stringify(res).slice(0, 2000)}`);
			}
		} catch (err) {
			output.appendLine(`invokeTool failed: ${String(err)}`);
		}
	});
	context.subscriptions.push(invokeCmd);

	const openLogCmd = vscode.commands.registerCommand('geminiMcp.openTaskLog', async (taskId: string) => {
		if (!taskId) {
			return;
		}
		await vscode.commands.executeCommand('vscode.open', vscode.Uri.parse(`tasks://${taskId}/log`));
	});
	context.subscriptions.push(openLogCmd);

	statusMonitor.updateConfig(initialConfig);
}

export function deactivate() {
	// Nothing to dispose; VS Code handles MCP server lifecycle
}
