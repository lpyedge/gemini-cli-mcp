// Preload hook to provide a repo-local `vscode` mock during Node-based tests.
// This file is meant to be passed to Node via `-r ./test/setup-vscode-mock.cjs`.
const Module = require('module');
const path = require('path');
const origLoad = Module._load;
Module._load = function(request, parent, isMain) {
  if (request === 'vscode') {
    // Resolve mock relative to this file
    return origLoad.call(this, path.join(__dirname, 'helpers', 'vscodeMock.cjs'));
  }
  return origLoad.apply(this, arguments);
};

// Also set an env var so tests can detect the mock if needed
process.env.VSCODE_MOCK_PRELOADED = '1';
