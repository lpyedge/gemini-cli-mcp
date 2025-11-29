#!/usr/bin/env node
// Simple smoke test: start a local stdio-style socket server and a client
// to validate path selection and newline-delimited JSON framing.
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

function sha1(input) { return crypto.createHash('sha1').update(input).digest('hex'); }
function defaultSocketPath() {
  const fp = sha1(process.cwd()).slice(0,8);
  if (process.platform === 'win32') return `\\.\\pipe\\gemini-mcp-smoke-${fp}`;
  return path.join(os.tmpdir(), `gemini-mcp-smoke-${fp}.sock`);
}

async function startServer(socketPath) {
  return new Promise((resolve, reject) => {
    const server = net.createServer((socket) => {
      socket.setEncoding('utf8');
      let buffer = '';
      socket.on('data', (chunk) => {
        buffer += chunk;
        let idx;
        while ((idx = buffer.indexOf('\n')) >= 0) {
          const raw = buffer.slice(0, idx).trim();
          buffer = buffer.slice(idx + 1);
          if (!raw) continue;
          try {
            const payload = JSON.parse(raw);
            // echo a simple response
            const resp = { id: payload.id ?? null, status: 200, body: { ok: true, echo: payload } };
            socket.write(JSON.stringify(resp) + '\n');
          } catch (err) {
            socket.write(JSON.stringify({ status: 400, error: String(err) }) + '\n');
          }
        }
      });
    });
    server.on('error', reject);
    server.listen(socketPath, () => {
      server.removeAllListeners('error');
      resolve(server);
    });
  });
}

async function run() {
  const socketPath = defaultSocketPath();
  if (process.platform !== 'win32' && fs.existsSync(socketPath)) {
    try { fs.unlinkSync(socketPath); } catch {}
  }
  const server = await startServer(socketPath);
  console.log('smoke server listening', socketPath);

  const client = net.connect(socketPath, () => {
    const ping = { id: 'smoke1', type: 'health' };
    client.write(JSON.stringify(ping) + '\n');
  });
  client.setEncoding('utf8');
  client.on('data', (d) => {
    console.log('client received:', d.trim());
    client.end();
    server.close(() => {
      if (process.platform !== 'win32') try { fs.unlinkSync(socketPath); } catch {}
      process.exit(0);
    });
  });
  client.on('error', (e) => { console.error('client error', e); process.exit(2); });
}

run().catch((e) => { console.error('smoke failed', e); process.exit(1); });
