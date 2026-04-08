import { execa } from 'execa';
import { execSync } from 'child_process';
import { existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import logger from '../../lib/logger.js';
import { CLAUDE_TIMEOUT_MS } from '../../lib/constants.js';

// Track active subprocesses for pause/kill
const _activeProcesses = new Map();

export function registerProcess(sprintId, subprocess) {
  _activeProcesses.set(sprintId, subprocess);
}

export function killProcess(sprintId) {
  const proc = _activeProcesses.get(sprintId);
  if (!proc) return false;
  try {
    proc.kill('SIGTERM');
    logger.info({ sprintId }, 'Claude subprocess killed via SIGTERM');
  } catch (err) {
    logger.warn({ sprintId, error: err.message }, 'Failed to kill subprocess');
  }
  _activeProcesses.delete(sprintId);
  return true;
}

export function deregisterProcess(sprintId) {
  _activeProcesses.delete(sprintId);
}

/**
 * Resolve the claude binary path.
 * Checks: 1) `claude` in PATH  2) macOS .app bundle  3) ENV override
 */
function resolveClaudeBin() {
  if (process.env.CLAUDE_BIN) return process.env.CLAUDE_BIN;

  // Check if `claude` is in PATH
  try {
    execSync('which claude', { stdio: 'pipe' });
    return 'claude';
  } catch {
    // not in PATH
  }

  // macOS: Claude desktop app bundles the CLI
  const appSupport = join(homedir(), 'Library', 'Application Support', 'Claude');
  try {
    const codeDir = join(appSupport, 'claude-code');
    if (existsSync(codeDir)) {
      const versions = readdirSync(codeDir).sort().reverse();
      for (const v of versions) {
        const bin = join(codeDir, v, 'claude.app', 'Contents', 'MacOS', 'claude');
        if (existsSync(bin)) return bin;
      }
    }
  } catch {
    // not found
  }

  // Fallback — hope it's in PATH at runtime
  return 'claude';
}

let _claudeBin = null;
function getClaudeBin() {
  if (!_claudeBin) {
    _claudeBin = resolveClaudeBin();
    logger.info({ claudeBin: _claudeBin }, 'Resolved claude binary');
  }
  return _claudeBin;
}

/**
 * Run claude --print and return stdout.
 *
 * @param {Object} options
 * @param {string} options.prompt     - Prompt string
 * @param {string[]} options.tools    - Allowed tools ([] = no --allowedTools flag)
 * @param {string} options.cwd        - Working directory
 * @param {number} options.timeoutMs  - Timeout in ms
 * @param {Function} options.onChunk  - Callback for streaming stdout chunks
 * @returns {Promise<{success: boolean, output: string, durationMs: number, error?: string}>}
 */
export async function runClaude({
  prompt,
  tools = [],
  cwd = process.cwd(),
  timeoutMs = CLAUDE_TIMEOUT_MS,
  onChunk = null,
  sprintId = null,
}) {
  // Validate cwd exists — ENOENT on missing cwd is confusing
  if (!existsSync(cwd)) {
    logger.error({ cwd }, 'Working directory does not exist');
    return {
      success: false,
      output: '',
      error: `Working directory does not exist: ${cwd}`,
      durationMs: 0,
    };
  }

  const useStreaming = !!onChunk;
  const args = ['--print', '-p', prompt];

  if (useStreaming) {
    args.push('--verbose', '--output-format', 'stream-json');
  }

  if (tools.length > 0) {
    args.push('--allowedTools', tools.join(','));
  }

  logger.info({
    cwd,
    promptLength: prompt.length,
    tools,
    streaming: useStreaming,
  }, 'Spawning claude --print');

  const startTime = Date.now();

  try {
    const subprocess = execa(getClaudeBin(), args, {
      cwd,
      timeout: timeoutMs,
      maxBuffer: 100 * 1024 * 1024,
      all: true,
      stdin: 'ignore',
    });

    if (sprintId) {
      registerProcess(sprintId, subprocess);
      // Save PID to DB for orphan cleanup on restart
      if (subprocess?.pid) {
        const prismaModule = await import('../../lib/prisma.js');
        prismaModule.default.sprint.update({
          where: { id: sprintId },
          data: { claudePid: subprocess.pid },
        }).catch((err) => logger.warn({ err: err.message }, 'Could not save claudePid'));
      }
    }

    let output = '';
    let finalResult = '';
    let stderr = '';
    let lineBuffer = '';

    subprocess.stdout?.on('data', (chunk) => {
      const text = chunk.toString();
      output += text;

      if (useStreaming) {
        // Parse stream-json: each line is a JSON event
        lineBuffer += text;
        const lines = lineBuffer.split('\n');
        lineBuffer = lines.pop() || ''; // keep incomplete last line in buffer

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const event = JSON.parse(line);
            if (event.type === 'assistant' && event.message?.content) {
              for (const block of event.message.content) {
                if (block.type === 'text' && block.text) {
                  onChunk(block.text);
                } else if (block.type === 'tool_use') {
                  onChunk(`\n🔧 ${block.name}(${JSON.stringify(block.input || {}).substring(0, 200)})\n`);
                }
              }
            } else if (event.type === 'tool_result') {
              const content = typeof event.content === 'string' ? event.content : JSON.stringify(event.content || '');
              onChunk(`\n📄 Result: ${content.substring(0, 300)}${content.length > 300 ? '...' : ''}\n`);
            } else if (event.type === 'result') {
              finalResult = event.result || '';
            }
          } catch {
            // Not valid JSON line — skip
          }
        }
      } else {
        if (onChunk) onChunk(text);
      }
    });

    subprocess.stderr?.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    await subprocess;

    const durationMs = Date.now() - startTime;
    const resultOutput = useStreaming ? (finalResult || output) : output;
    logger.info({ durationMs, outputLength: resultOutput.length, streaming: useStreaming }, 'Claude completed');

    return { success: true, output: resultOutput, durationMs };

  } catch (err) {
    const durationMs = Date.now() - startTime;

    if (err.timedOut) {
      logger.error({ durationMs }, 'Claude timed out');
      return { success: false, output: '', error: 'TIMEOUT', durationMs };
    }

    logger.error({ error: err.message, durationMs }, 'Claude failed');
    return { success: false, output: '', error: err.message, durationMs };
  } finally {
    if (sprintId) deregisterProcess(sprintId);
  }
}

/**
 * Retry wrapper with exponential backoff.
 * Retries all errors including TIMEOUT, up to maxAttempts.
 * Each TIMEOUT retry increases timeout by 1.5x.
 * Backoff: 5s → 15s → 45s
 */
export async function runClaudeWithRetry(options, maxAttempts = 3) {
  let opts = { ...options };
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const result = await runClaude(opts);

    if (result.success) return result;
    if (attempt === maxAttempts) return result;

    // Increase timeout for next attempt if this one timed out
    if (result.error === 'TIMEOUT') {
      opts = { ...opts, timeoutMs: (opts.timeoutMs || CLAUDE_TIMEOUT_MS) * 1.5 };
    }

    const delay = 5000 * Math.pow(3, attempt - 1);
    logger.warn({ attempt, maxAttempts, delay, error: result.error }, 'Claude failed, retrying...');
    await new Promise((r) => setTimeout(r, delay));
  }
}
