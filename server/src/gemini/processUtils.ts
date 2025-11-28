import { spawn, spawnSync, ChildProcess } from 'node:child_process';

export function terminateProcessTree(child: ChildProcess) {
    const pid = child.pid;
    if (!pid) {
        try {
            child.kill();
        } catch {
            // ignore
        }
        return;
    }
    if (process.platform === 'win32') {
        try {
            // Use spawnSync to ensure taskkill completes before we return.
            spawnSync('taskkill', ['/pid', pid.toString(), '/t', '/f'], { stdio: 'ignore' });
        } catch {
            try {
                child.kill();
            } catch {
                // ignore
            }
        }
    } else {
        try {
            // Try to kill the process group first (works if child was started detached)
            process.kill(-pid, 'SIGTERM');
        } catch {
            // ignore
        }
        try {
            child.kill('SIGTERM');
        } catch {
            // ignore
        }
        // After a short delay, attempt SIGKILL to ensure termination.
        setTimeout(() => {
            try {
                process.kill(-pid, 'SIGKILL');
            } catch {
                // ignore
            }
            try {
                child.kill('SIGKILL');
            } catch {
                // ignore
            }
        }, 250);
    }
}

export async function execGeminiCommand(command: string, spawnArgs: string[], timeoutMs = 10000) {
    return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
        const child = spawn(command, spawnArgs, {
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: process.platform === 'win32'
        });
        let stdout = '';
        let stderr = '';
        child.stdout?.on('data', (chunk) => {
            stdout += chunk.toString();
        });
        child.stderr?.on('data', (chunk) => {
            stderr += chunk.toString();
        });
        const timer = timeoutMs
            ? setTimeout(() => {
                  try {
                      terminateProcessTree(child);
                  } catch (e) {
                      // ignore
                  }
                  reject(new Error('Timed out during Gemini CLI health check.'));
              }, timeoutMs)
            : undefined;
        child.on('error', (error) => {
            if (timer) clearTimeout(timer);
            reject(error);
        });
        child.on('close', (code) => {
            if (timer) clearTimeout(timer);
            if (code === 0) {
                resolve({ stdout, stderr });
            } else {
                const text = (stderr || stdout || `Gemini CLI exited with code ${code}`).trim();
                reject(new Error(text));
            }
        });
    });
}

export default null;
