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
        let triedShellFallback = false;

        const spawnOnce = (cmd: string, args: string[]) => {
            const child = spawn(cmd, args, {
                stdio: ['ignore', 'pipe', 'pipe'],
                windowsHide: process.platform === 'win32',
                shell: process.platform === 'win32'
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

            const cleanupAndResolve = () => {
                if (timer) clearTimeout(timer);
                resolve({ stdout, stderr });
            };
            const cleanupAndReject = (err: Error) => {
                if (timer) clearTimeout(timer);
                reject(err);
            };

            child.on('error', (error: any) => {
                // If on Windows the command wasn't found (ENOENT), try a shell-based
                // invocation as a fallback which can resolve PATH/PATHEXT differences.
                if (!triedShellFallback && process.platform === 'win32' && error && (error.code === 'ENOENT' || String(error).toLowerCase().includes('enoent'))) {
                    triedShellFallback = true;
                    try {
                        const comspec = process.env.ComSpec || 'C:\\Windows\\System32\\cmd.exe';
                        // Use /c so cmd resolves the program via PATH and PATHEXT.
                        spawnOnce(comspec, ['/c', command, ...spawnArgs]);
                    } catch (e) {
                        cleanupAndReject(error instanceof Error ? error : new Error(String(error)));
                    }
                    return;
                }
                cleanupAndReject(error instanceof Error ? error : new Error(String(error)));
            });

            child.on('close', (code) => {
                if (code === 0) {
                    cleanupAndResolve();
                } else {
                    const text = (stderr || stdout || `Gemini CLI exited with code ${code}`).trim();
                    cleanupAndReject(new Error(text));
                }
            });
        };

        spawnOnce(command, spawnArgs);
    });
}

export default null;
