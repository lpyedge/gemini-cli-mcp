import * as vscode from 'vscode';
import path from 'node:path';
import fs from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';

import { readConfig, resolveTaskCwd } from './extension/configUtils';
// 'os' not used in this module; removed to avoid unused import
// GeminiCliHealth removed: server snapshot is now authoritative
import { GeminiTaskTreeProvider } from './extension/treeProvider';
import { TaskStatusMonitor } from './extension/statusMonitor';
import { runOrchestrator } from './extension/orchestrator';
import * as mcpClientModule from './extension/mcpClient';
import { ModelBridge } from './extension/modelBridge';
import { getToolNames } from './extension/mcpManifest';
import { logger } from './extension/logger';

// The activate module wires the UI pieces together and registers the MCP provider
// and extension commands. It intentionally keeps the wiring logic concise and
// imports well-scoped modules for the implementation details.

async function buildMcpDefinitions(
	context: vscode.ExtensionContext,
	cfg: any,
	providerTriggerCount: number
): Promise<vscode.McpServerDefinition[]> {
	const servers: vscode.McpServerDefinition[] = [];

	// Prefer an absolute path to the bundled server entry. Relying on cwd+relative
	// args can fail if packaging/layout changes; use explicit path instead.
	const serverCwd = vscode.Uri.joinPath(context.extensionUri, 'server').fsPath;
	const serverEntry = vscode.Uri.joinPath(context.extensionUri, 'server', 'dist', 'index.js').fsPath;
	logger.info(`Gemini MCP: resolved serverEntry=${serverEntry}`);

	// If the bundled server entry is missing, avoid returning a server definition.
	if (!fs.existsSync(serverEntry)) {
		logger.warn(`Gemini MCP: server entry not found: ${serverEntry}. Skipping MCP server registration.`);
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
			logger.info(`Gemini MCP: configured taskCwd not resolvable; falling back to workspace root ${workspaceRoot}`);
			resolvedTaskCwd = workspaceRoot;
		} else {
			logger.warn('Gemini MCP: no workspace folder available and `taskCwd` not set or invalid. Skipping MCP server registration to avoid using VS Code install directory as taskCwd.');
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
	logger.info(`Gemini MCP: starting node executable=${nodeBin} args=${JSON.stringify(args)}`);

	// Merge process.env to preserve PATH and other runtime environment values
	const envVars: NodeJS.ProcessEnv = {
		...process.env,
		GEMINI_MAX_WORKERS: String(Math.max(1, cfg.maxWorkers)),
		GEMINI_TASK_CWD: resolvedTaskCwd,
		GEMINI_MAX_QUEUE: String(Math.max(1, cfg.maxQueue))
	};
	// For diagnostics, log only the GEMINI_* keys plus PATH to avoid dumping unrelated secrets
	try {
		const logged: Record<string, string | undefined> = {};
		Object.keys(envVars).forEach((k) => {
			if (k.startsWith('GEMINI_') || k === 'PATH') logged[k] = envVars[k];
		});
		logger.info(`Gemini MCP: env subset: ${JSON.stringify(logged)}`);
	} catch (e) {
		logger.warn(`Gemini MCP: failed to stringify env for logging: ${String(e)}`);
	}

	try {
		// Read extension package.json to source the version dynamically for server definition
		let version = '1.0.0';
		try {
			const raw = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(context.extensionUri, 'package.json'));
			const parsed = JSON.parse(Buffer.from(raw).toString('utf8'));
			if (parsed && parsed.version) version = parsed.version;
		} catch (err) {
			logger.warn(`Gemini MCP: failed to read package.json for version fallback: ${String(err)}`);
		}

		const sanitizedEnv: Record<string, string> = {};
		Object.keys(envVars).forEach((k) => {
			const v = envVars[k];
			if (v !== undefined && v !== null) sanitizedEnv[k] = String(v);
		});

		const definition = createMcpDefinition({
			vscodeApi: vscode,
			id: 'gemini-cli-mcp',
			command: nodeBin,
			args,
			env: sanitizedEnv,
			version,
			cwd: vscode.Uri.file(serverCwd)
		});
		if (definition) {
			servers.push(definition);
			logger.info(`Gemini MCP: prepared ${servers.length} MCP server definition(s) for host.`);
		} else {
			logger.warn('Gemini MCP: host MCP API unavailable; cannot publish server definition.');
		}
	} catch (err) {
		logger.error(`Gemini MCP: failed to create MCP server definition ${String(err)}`);
	}

	return servers;
}

type CompatibleMcpDefinition = {
	id: string;
	command: string;
	args?: string[];
	env?: Record<string, string>;
	version?: string;
	type?: string;
	transport?: {
		type: 'stdio';
		command: string;
		args?: string[];
		env?: Record<string, string>;
		options?: {
			cwd?: vscode.Uri | string;
		};
	};
	cwd?: vscode.Uri | string | null;
	displayName?: string;
};

interface DefinitionFactoryOptions {
	vscodeApi: typeof vscode;
	id: string;
	command: string;
	args: string[];
	env: Record<string, string>;
	version: string;
	cwd: vscode.Uri;
}

function createMcpDefinition(options: DefinitionFactoryOptions): vscode.McpServerDefinition | undefined {
	const { vscodeApi, id, command, args, env, version, cwd } = options;
	const cwdPath = cwd?.fsPath ?? cwd;
	const hostLm: any = (vscodeApi as any).lm ?? (vscodeApi as any).mcp ?? (vscodeApi as any);

	const ctorCandidates = [
		(vscodeApi as any).McpStdioServerDefinition,
		hostLm?.McpStdioServerDefinition,
		hostLm?.StdioServerDefinition
	].filter((c) => typeof c === 'function');

	if (ctorCandidates.length > 0) {
		try {
			const StdioCtor = ctorCandidates[0] as new (
				id: string,
				command: string,
				args: string[] | undefined,
				env: Record<string, string> | undefined,
				version: string | undefined
			) => vscode.McpServerDefinition & { cwd?: vscode.Uri | string | null; displayName?: string };
			const def = new StdioCtor(id, command, args, env, version);
			const compatDef = def as unknown as CompatibleMcpDefinition;
			if ('cwd' in def) {
				const current = compatDef.cwd;
				compatDef.cwd = typeof current === 'string' ? cwdPath : (cwd ?? cwdPath);
			}
			if ('displayName' in def && !compatDef.displayName) {
				compatDef.displayName = 'Gemini CLI MCP';
			}
			logger.info('Gemini MCP: MCP definition created via ctor path.');
			return def;
		} catch (error) {
			logger.warn(`Gemini MCP: ctor-based MCP definition failed: ${String(error)}`);
		}
	}

	const factoryFns = [
		hostLm?.createMcpServerDefinition,
		(vscodeApi as any).createMcpServerDefinition
	].filter((fn) => typeof fn === 'function');

	if (factoryFns.length > 0) {
		try {
			const createFn = factoryFns[0] as (payload: CompatibleMcpDefinition) => vscode.McpServerDefinition;
			const result = createFn({
				id,
				displayName: 'Gemini CLI MCP',
				type: 'stdio',
				command,
				args,
				env,
				version,
				transport: {
					type: 'stdio',
					command,
					args,
					env,
					options: {
						cwd: cwdPath
					}
				}
			});
			logger.info('Gemini MCP: MCP definition created via factory path.');
			return result;
		} catch (error) {
			logger.warn(`Gemini MCP: factory-based MCP definition failed: ${String(error)}`);
		}
	}

	const fallback: CompatibleMcpDefinition = {
		id,
		displayName: 'Gemini CLI MCP',
		version,
		type: 'stdio',
		command,
		args,
		env,
		cwd: cwdPath,
		transport: {
			type: 'stdio',
			command,
			args,
			env,
			options: { cwd: cwdPath }
		}
	};
	logger.info('Gemini MCP: falling back to plain MCP definition object; host compatibility may vary.');
	return fallback as unknown as vscode.McpServerDefinition;
}

export function activate(context: vscode.ExtensionContext) {
	const statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
	statusItem.name = 'Gemini CLI MCP';
	statusItem.text = '$(hubot) Gemini';
	statusItem.tooltip = 'Copilot orchestrates local Gemini CLI workers via MCP';
	statusItem.show();
	context.subscriptions.push(statusItem);

	// The logger module manages the OutputChannel; no local channel needed here.

	const providerEmitter = new vscode.EventEmitter<void>();
	context.subscriptions.push(providerEmitter);
	// No local CLI health gating: server snapshot is authoritative.

	const taskTreeProvider = new GeminiTaskTreeProvider();
	const treeRegistration = vscode.window.registerTreeDataProvider('geminiMcp.tasks', taskTreeProvider);
	context.subscriptions.push(treeRegistration);

	const statusMonitor = new TaskStatusMonitor(context, statusItem, taskTreeProvider);
	context.subscriptions.push(statusMonitor);

		// Create ModelBridge instance but defer starting it until the server
		// reports a healthy Gemini CLI via MCP snapshot. This prevents the
		// extension from registering the bridge when the server-side CLI is
		// not ready (requirement: only register when server reports cli ok).
		const modelBridge = new ModelBridge();
		context.subscriptions.push(modelBridge);

		// Subscribe to MCP status snapshots so we can start/stop the bridge
		// based on server-reported CLI health.
		try {
			const unsubSnapshot = (mcpClientModule as any).onStatusSnapshot((s: any) => {
				try {
					const cliState = s && s.cliStatus && s.cliStatus.state ? String(s.cliStatus.state) : undefined;
					if (cliState === 'ok') {
						// start bridge if not already started
						try {
							void modelBridge.start();
							logger.info('Gemini MCP: modelBridge started after server reported CLI ok');
						} catch (e) {
							logger.warn('Gemini MCP: failed to start modelBridge after snapshot', String(e));
						}
					} else {
						// stop bridge if server reports not-ok
						try {
							void modelBridge.stop();
							logger.info('Gemini MCP: modelBridge stopped because server CLI not healthy');
						} catch (e) {
							// ignore
						}
					}
				} catch (e) {
					// swallow
				}
			});
			context.subscriptions.push({ dispose: unsubSnapshot });
			// Also check existing cached snapshot (if any) to decide immediate start
			try {
				const cached = (mcpClientModule as any).getLatestStatusSnapshot ? (mcpClientModule as any).getLatestStatusSnapshot() : undefined;
				const cliState = cached && cached.cliStatus && cached.cliStatus.state ? String(cached.cliStatus.state) : undefined;
				if (cliState === 'ok') {
					void modelBridge.start();
					logger.info('Gemini MCP: modelBridge started from existing snapshot');
				}
			} catch {}
		} catch (e) {
			// best-effort: if subscription fails, do not block activation
		}

	const initialConfig = readConfig();

	// Track how often the provider is asked to provide definitions (helpful for diagnostics)
	let providerTriggerCount = 0;
	providerEmitter.event(() => {
		providerTriggerCount += 1;
		logger.info(`Gemini MCP: providerEmitter fired (${providerTriggerCount} times)`);
	});
	// NOTE: providerEmitter should not be fired in tight loops; keep change handling scoped to UI/diagnostics.
	// Watch workspace folder changes. Only publish provider/start server when
	// a workspace folder exists to avoid spawning servers for empty windows.
	let embeddedClientStarted = false;
	const workspaceWatcher = vscode.workspace.onDidChangeWorkspaceFolders(() => {
		// Always refresh provider definitions when workspace changes
		providerEmitter.fire();
		// If a workspace folder has been added and embedded client not started,
		// attempt to start the embedded MCP client (non-blocking).
		const hasWorkspace = Array.isArray(vscode.workspace.workspaceFolders) && vscode.workspace.workspaceFolders.length > 0;
		if (hasWorkspace && !embeddedClientStarted) {
			embeddedClientStarted = true;
			(async () => {
				try {
					const cfg = readConfig();
					logger.info('Gemini MCP: initiating embedded server via getMcpClient (workspace change)');
					await mcpClientModule.getMcpClient(cfg);
					logger.info('Gemini MCP: getMcpClient resolved (server spawn attempted)');
				} catch (err) {
					logger.warn('Gemini MCP: getMcpClient failed to start server (workspace change)', String(err));
				}
			})();
		}
	});
	context.subscriptions.push(workspaceWatcher);

	const providerObj = {
		onDidChangeMcpServerDefinitions: providerEmitter.event,
		provideMcpServerDefinitions: async () => {
			logger.info(`Gemini MCP: provideMcpServerDefinitions called (#${providerTriggerCount + 1})`);
			const cfg = readConfig();
			return buildMcpDefinitions(context, cfg, providerTriggerCount);
		},
		resolveMcpServerDefinition: async (server: any) => server
	};

	// MCP host API can live under different namespaces depending on VS Code
	// version or proposed APIs. Feature-detect the provider registration API
	// rather than assuming `vscode.lm` exists to reduce strict engine bounds.
	const hostLm: any = (vscode as any).lm ?? (vscode as any).mcp ?? (vscode as any);
	let providerRegistered = false;
	if (hostLm && typeof hostLm.registerMcpServerDefinitionProvider === 'function') {
		const provider = hostLm.registerMcpServerDefinitionProvider('gemini-mcp-provider', providerObj);
		context.subscriptions.push(provider);
		providerRegistered = true;
	} else if (typeof (vscode as any).registerMcpServerDefinitionProvider === 'function') {
		// some hosts might expose a top-level registration function
		const provider = (vscode as any).registerMcpServerDefinitionProvider('gemini-mcp-provider', providerObj);
		context.subscriptions.push(provider);
		providerRegistered = true;
	} else {
		logger.warn('Gemini MCP: host does not support MCP server provider registration API; installing no-op shim for compatibility.');
		try {
			const existing = (globalThis as any).__geminiLmShim ?? (vscode as any).mcp ?? undefined;
			if (!existing || !existing.registerMcpServerDefinitionProvider) {
				(globalThis as any).__geminiLmShim = {
					registerMcpServerDefinitionProvider: (id: string, provider: any) => {
						logger.info(`Gemini MCP: registered no-op MCP provider (shim) for ${id}`);
						return { dispose: () => logger.info(`Gemini MCP: disposed no-op MCP provider (shim) for ${id}`) };
					}
				};
				// Ensure we clean up shim on deactivate
				context.subscriptions.push({ dispose: () => { try { delete (globalThis as any).__geminiLmShim; } catch {} } });
			}
		} catch (e) {
			logger.error(`Gemini MCP: failed to install no-op shim: ${String(e)}`);
		}
	}

	if (providerRegistered) {
		// Only publish provider definitions immediately if a workspace is open.
		const hasWorkspace = Array.isArray(vscode.workspace.workspaceFolders) && vscode.workspace.workspaceFolders.length > 0;
		if (hasWorkspace) {
			setTimeout(() => {
				logger.info('Gemini MCP: firing providerEmitter to publish initial MCP definitions.');
				providerEmitter.fire();
			}, 0);
		} else {
			logger.info('Gemini MCP: no workspace open at activation; deferring provider publication until workspace is opened.');
		}
	}

	const configWatcher = vscode.workspace.onDidChangeConfiguration((event) => {
		if (event.affectsConfiguration('geminiMcp')) {
			void modelBridge.restart();
			providerEmitter.fire();
			const cfg = readConfig();
			statusMonitor.updateConfig(cfg);
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

	// Best-effort: start an embedded MCP client so the bundled server is
	// actually spawned when the extension activates. Some hosts start MCP
	// servers themselves when the provider is registered; others defer
	// until a consumer connects. Explicitly calling `getMcpClient` ensures
	// the child server process is launched and that extension-side logging
	// will capture its stdout/stderr. This is non-blocking and will not
	// prevent activation if it fails.
	// Start embedded client only if workspace is open. Defer otherwise until the
	// workspace watcher notices folders being added. This prevents spawning the
	// server in empty Extension Development Host windows or when no workspace.
	const initialHasWorkspace = Array.isArray(vscode.workspace.workspaceFolders) && vscode.workspace.workspaceFolders.length > 0;
	if (initialHasWorkspace) {
		setTimeout(() => {
			(async () => {
				try {
					const cfg = readConfig();
					logger.info('Gemini MCP: initiating embedded server via getMcpClient');
					await mcpClientModule.getMcpClient(cfg);
					logger.info('Gemini MCP: getMcpClient resolved (server spawn attempted)');
				} catch (err) {
					logger.warn('Gemini MCP: getMcpClient failed to start server', String(err));
				}
			})();
		}, 500);
	} else {
		logger.info('Gemini MCP: deferring embedded server start until workspace is available.');
	}

	    const showStatusCmd = vscode.commands.registerCommand('geminiMcp.showStatus', async () => {
		    const cfg = readConfig();
			statusMonitor.updateConfig(cfg);
			// Prefer server-provided snapshot for status. If no snapshot available,
			// show a waiting message. This enforces server as authoritative source
			// for CLI/worker information in the UI.
			try {
				const snapshot = (mcpClientModule as any).getLatestStatusSnapshot ? (mcpClientModule as any).getLatestStatusSnapshot() : undefined;
				if (snapshot && snapshot.cliStatus && snapshot.cliStatus.state) {
					const cliState = snapshot.cliStatus.state;
					const cliMsg = snapshot.cliStatus.message ?? '';
					vscode.window.showInformationMessage(`Gemini CLI MCP workers: ${snapshot.maxWorkers ?? cfg.maxWorkers}, CLI: ${cliState} ${cliMsg}`);
				} else {
					vscode.window.showInformationMessage('Gemini CLI MCP: waiting for server snapshot (status unknown)');
				}
			} catch (e) {
				vscode.window.showInformationMessage('Gemini CLI MCP: status unavailable');
			}
		});
	context.subscriptions.push(showStatusCmd);

	// Diagnose command: prints config and verifies resolved paths and files
	const diagnoseCmd = vscode.commands.registerCommand('geminiMcp.diagnose', async () => {
		const cfg = readConfig();
		statusMonitor.updateConfig(cfg);
		const resolvedTaskCwd = resolveTaskCwd(cfg.taskCwd) || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || process.cwd();
		const serverEntry = path.join(context.extensionUri.fsPath, 'server', 'dist', 'index.js');
		const exists = fs.existsSync(serverEntry);
		logger.show(true);
		logger.info('--- Gemini MCP diagnose ---');
		logger.info(`config: ${JSON.stringify(cfg)}`);
		logger.info(`resolvedTaskCwd: ${resolvedTaskCwd}`);
		logger.info(`serverEntry: ${serverEntry}`);
		logger.info(`serverEntry exists: ${exists}`);
		try {
			const snapshot = (mcpClientModule as any).getLatestStatusSnapshot ? (mcpClientModule as any).getLatestStatusSnapshot() : undefined;
			if (snapshot) {
				logger.info(`server snapshot: ${JSON.stringify(snapshot).slice(0,2000)}`);
			} else {
				logger.info('server snapshot: <none - waiting for server>');
			}
		} catch (e) {
			logger.warn('diagnose: failed to read snapshot', String(e));
		}
		// Local CLI health checks removed; rely on server snapshot for runtime status.
		vscode.window.showInformationMessage('Gemini MCP: diagnosis written to Output -> "Gemini CLI MCP"');
	});
	context.subscriptions.push(diagnoseCmd);

	const orchestrateCmd = vscode.commands.registerCommand('geminiMcp.orchestrateReview', async () => {
		logger.show(true);
		logger.info('Gemini MCP: starting orchestrated review...');
		try {
			const cfg = readConfig();
			await runOrchestrator(cfg);
			logger.info('Gemini MCP: orchestrated review finished.');
		} catch (err) {
			logger.error(`Orchestrator failed: ${String(err)}`);
		}
	});
	context.subscriptions.push(orchestrateCmd);

	const invokeCmd = vscode.commands.registerCommand('geminiMcp.invokeTool', async (toolName?: string, args?: any) => {
		logger.show(true);
		const cfg = readConfig();
		try {
			if (!toolName) {
				const manifestTools = Array.from(new Set(getToolNames() ?? []));
				if (manifestTools.length === 0) {
					await vscode.window.showWarningMessage('Gemini MCP: no tools declared in mcp.json; nothing to invoke.');
					return;
				}
				toolName = await vscode.window.showQuickPick(manifestTools, { placeHolder: 'Select MCP tool to invoke' });
				if (!toolName) return;
			}
			if (!args) {
				const json = await vscode.window.showInputBox({ placeHolder: 'Enter tool arguments as JSON (or leave blank for defaults)' });
				if (json && json.trim().length) args = JSON.parse(json);
			}
			// Use orchestrator helper to run tool via MCP
			const mc = await mcpClientModule.getMcpClient(cfg);
			const client: any = mc.client;
			const res = await client.callTool({ name: toolName, arguments: args ?? {} });
			const first = res.content?.find((c: any) => c.type === 'text');
			if (first && first.text) {
				logger.info(`Tool ${toolName} -> ${first.text}`);
			} else {
				logger.debug(`Tool ${toolName} -> ${JSON.stringify(res).slice(0, 2000)}`);
			}
		} catch (err) {
			logger.error(`invokeTool failed: ${String(err)}`);
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

export async function deactivate() {
	// Attempt to close any MCP client we started so the child server
	// process is cleanly shut down. This is best-effort and will not
	// throw if the client was never created or already closed.
	try {
		await mcpClientModule.closeMcpClient();
	} catch {
		// ignore
	}
}
