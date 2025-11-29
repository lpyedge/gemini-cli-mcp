const path = require('path');

class EventEmitter {
  constructor() {
    this._listeners = [];
  }
  event(listener) {
    this._listeners.push(listener);
    return { dispose: () => {} };
  }
  fire(arg) {
    for (const l of this._listeners.slice()) {
      try { l(arg); } catch (e) { /* swallow */ }
    }
  }
  dispose() {}
}

class McpStdioServerDefinition {
  constructor(id, command, args, env, version) {
    this.id = id;
    this.command = command;
    this.args = args;
    this.env = env;
    this.version = version;
    this.cwd = null;
  }
}

const window = {
  createOutputChannel: (name) => ({
    appendLine: (s) => { /* keep quiet in tests */ },
    show: () => {},
    clear: () => {}
  }),
  createStatusBarItem: () => ({ name: '', text: '', tooltip: '', show: () => {}, dispose: () => {} }),
  registerTreeDataProvider: () => ({ dispose: () => {} })
};

const workspace = {
  workspaceFolders: [{ uri: { fsPath: process.cwd() } }],
  fs: {
    readFile: async () => { throw new Error('workspace.fs.readFile not implemented in vscode mock'); }
  },
  onDidChangeWorkspaceFolders: () => ({ dispose: () => {} }),
  onDidChangeConfiguration: () => ({ dispose: () => {} }),
  getConfiguration: () => ({ get: () => undefined })
};

const commands = {
  registerCommand: () => ({ dispose: () => {} }),
  executeCommand: async () => {}
};

const Uri = {
  file: (fsPath) => ({ fsPath }),
  joinPath: (uri, ...parts) => ({ fsPath: path.join(uri.fsPath, ...parts) }),
  parse: (s) => ({ fsPath: s })
};

const lm = {
  registerMcpServerDefinitionProvider: (id, provider) => ({ dispose: () => {} })
};

module.exports = {
  EventEmitter,
  McpStdioServerDefinition,
  window,
  workspace,
  commands,
  Uri,
  lm,
};
