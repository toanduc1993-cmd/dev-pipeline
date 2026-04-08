import prisma from '../lib/prisma.js';

// GET /api/config
export async function getConfig(_req, res) {
  let config = await prisma.pipelineConfig.findUnique({ where: { id: 'singleton' } });
  if (!config) {
    config = await prisma.pipelineConfig.create({ data: { id: 'singleton' } });
  }
  res.json(config);
}

// PUT /api/config
export async function updateConfig(req, res) {
  const { maxParallelAgents, maxRetryRounds, taskTimeoutMins, qaChunkSize, masterMaxTokens, telegramEnabled } = req.body;

  const config = await prisma.pipelineConfig.upsert({
    where: { id: 'singleton' },
    create: { id: 'singleton' },
    update: {
      ...(maxParallelAgents !== undefined && { maxParallelAgents }),
      ...(maxRetryRounds !== undefined && { maxRetryRounds }),
      ...(taskTimeoutMins !== undefined && { taskTimeoutMins }),
      ...(qaChunkSize !== undefined && { qaChunkSize }),
      ...(masterMaxTokens !== undefined && { masterMaxTokens }),
      ...(telegramEnabled !== undefined && { telegramEnabled }),
    },
  });
  res.json(config);
}

// POST /api/config/verify-claude
export async function verifyClaude(_req, res) {
  try {
    const { runClaude } = await import('../services/claude/claudeService.js');
    const result = await runClaude({ prompt: 'Say HELLO_VERIFY', tools: [], timeoutMs: 30000 });
    res.json({ ok: result.success, output: (result.output || '').substring(0, 500) });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
}

// POST /api/config/verify-git
export async function verifyGit(_req, res) {
  try {
    const { execa } = await import('execa');
    const { stdout } = await execa('git', ['--version']);
    const { stdout: worktreeOutput } = await execa('git', ['worktree', 'list'], { cwd: process.cwd() }).catch(() => ({ stdout: 'N/A (not a git repo)' }));
    res.json({ ok: true, gitVersion: stdout.trim(), worktrees: worktreeOutput.trim() });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
}
