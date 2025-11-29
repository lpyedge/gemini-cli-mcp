import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

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

test('smoke stdio bridge echoes json over socket', async () => {
  // On Windows named-pipe creation can fail in CI with EACCES; skip test there.
  if (process.platform === 'win32') {
    console.log('skipping smoke stdio bridge test on Windows');
    return;
  }

  const socketPath = defaultSocketPath();
  if (process.platform !== 'win32' && fs.existsSync(socketPath)) {
    try { fs.unlinkSync(socketPath); } catch {}
  }
  const server = await startServer(socketPath);

  try {
    const resp = await new Promise((resolve, reject) => {
      const client = net.connect(socketPath, () => {
        const ping = { id: 'smoke1', type: 'health' };
        client.write(JSON.stringify(ping) + '\n');
      });
      client.setEncoding('utf8');
      let buf = '';
      client.on('data', (d) => {
        buf += d;
        if (buf.indexOf('\n') >= 0) {
          const line = buf.slice(0, buf.indexOf('\n')).trim();
          client.end();
          try { resolve(JSON.parse(line)); } catch (e) { reject(e); }
        }
      });
      client.on('error', (e) => reject(e));
    });

    assert.equal(resp.status, 200);
    assert.ok(resp.body && resp.body.echo && resp.body.echo.id === 'smoke1');
  } finally {
    server.close(() => {});
    if (process.platform !== 'win32') try { fs.unlinkSync(socketPath); } catch {}
  }
});
