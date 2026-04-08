import { runClaudeWithRetry } from '../claude/claudeService.js';
import { parseClaudeOutput } from '../claude/outputParser.js';
import { PromptBuilder } from '../claude/promptBuilder.js';
import path from 'path';
import logger from '../../lib/logger.js';

export class BugfixRunner {
  constructor(orchestrator, deployRunner) {
    this.orch = orchestrator;
    this._deploy = deployRunner;
  }

  async runBugfix(project, errorDescription, { originalSpec = null, sprintNumber = null } = {}) {
    const repoPath = project.repoPath;
    logger.info({ projectId: project.id, repoPath }, 'Running bugfix — 3 agent pipeline');

    const { exec } = await import('child_process');
    const { promisify } = await import('util');
    const execAsync = promisify(exec);
    const { existsSync } = await import('fs');

    const maxAttempts = 3;
    const builder = new PromptBuilder(repoPath);

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      logger.info({ projectId: project.id, attempt }, `Bugfix attempt ${attempt}/${maxAttempts}`);

      // ── AGENT 1: DIAGNOSTICIAN ────────────────
      this.orch._emit('qa:fix_progress', {
        sprintId: null, phase: 'agent1',
        message: `Lan ${attempt}: Diagnostician dang phan tich loi...`,
      });

      let fileTree = '';
      try {
        const { stdout } = await execAsync(
          'find . -type f -not -path "./.git/*" -not -path "*__pycache__*" -not -path "*/node_modules/*" -not -path "*/.pytest_cache/*" | head -100',
          { cwd: repoPath, timeout: 5000 }
        );
        fileTree = stdout;
      } catch { fileTree = '[Could not read file tree]'; }

      let errorLogs = '';
      try {
        const hasFastAPI = existsSync(path.join(repoPath, 'src', 'api', 'main.py'));
        const hasPackageJson = existsSync(path.join(repoPath, 'package.json'));
        let testCmd = '';
        if (hasFastAPI) testCmd = `cd "${repoPath}" && python3 -c "from src.api.main import app; print('IMPORT OK')" 2>&1`;
        else if (hasPackageJson) testCmd = `cd "${repoPath}" && node -e "require('./index.js')" 2>&1`;
        if (testCmd) {
          try {
            const { stdout, stderr } = await execAsync(testCmd, { timeout: 10000 });
            errorLogs = (stdout + stderr).substring(0, 2000);
          } catch (e) {
            errorLogs = ((e.stdout?.toString() || '') + (e.stderr?.toString() || '') || e.message).substring(0, 2000);
          }
        }
      } catch {}

      const diagnosePrompt = builder.buildBugDiagnosePrompt({
        errorDescription: attempt > 1 ? `${errorDescription}\n\n[LAN ${attempt}] Fix truoc chua thanh cong:\n${errorLogs}` : errorDescription,
        fileTree, errorLogs,
      });

      const diagResult = await runClaudeWithRetry({ prompt: diagnosePrompt, tools: ['Read', 'Bash'], cwd: repoPath });

      if (!diagResult.success) { logger.error({ attempt }, 'Diagnostician failed'); continue; }

      const diagParsed = parseClaudeOutput(diagResult.output, null);
      const fixPlan = diagParsed.data?.fixPlan || [];
      const rootCause = diagParsed.data?.rootCause || 'Unknown';

      if (fixPlan.length === 0) { logger.warn({ attempt, rootCause }, 'Diagnostician found no fix plan'); continue; }

      logger.info({ attempt, rootCause, fixCount: fixPlan.length }, 'Diagnostician completed');

      // ── AGENT 2: FIXER ────────────────
      this.orch._emit('qa:fix_progress', {
        sprintId: null, phase: 'agent2',
        message: `Lan ${attempt}: Fixer dang sua ${fixPlan.length} file(s)...`,
      });

      const fixPrompt = builder.buildBugFixPrompt({ fixPlan, errorDescription });
      const fixResult = await runClaudeWithRetry({
        prompt: fixPrompt, tools: ['Read', 'Write', 'Bash'], cwd: repoPath,
        onChunk: (chunk) => this.orch._emit('agent:chunk', { taskId: 'bugfix', agentSlot: 0, chunk }),
      });

      if (!fixResult.success) { logger.error({ attempt }, 'Fixer failed'); continue; }

      const fixParsed = parseClaudeOutput(fixResult.output, null);
      const filesFixed = fixParsed.data?.filesFixed || [];
      logger.info({ attempt, filesFixed: filesFixed.length }, 'Fixer completed');

      // ── AGENT 3: VERIFIER ────────────────
      this.orch._emit('qa:fix_progress', {
        sprintId: null, phase: 'agent3',
        message: `Lan ${attempt}: Verifier dang kiem tra...`,
      });

      const verifyPrompt = builder.buildBugVerifyPrompt({ errorDescription, fixResult: fixParsed.data || {}, originalSpec, sprintNumber });
      const verifyResult = await runClaudeWithRetry({ prompt: verifyPrompt, tools: ['Read', 'Bash'], cwd: repoPath });
      const verifyParsed = parseClaudeOutput(verifyResult.output, null);
      const verified = verifyParsed.data?.status === 'PASS';

      if (verified) {
        logger.info({ projectId: project.id, attempt }, 'Verifier PASS — bugfix confirmed');
        this.orch._emit('qa:fix_progress', { sprintId: null, phase: 'restarting', message: 'Fix thanh cong! Dang khoi dong lai...' });

        let restartResult = null;
        try { restartResult = await this._deploy.runLocalSetup(project); } catch {}

        await this.orch.notif.send({
          projectId: project.id, type: 'sprint_complete',
          title: 'Bug da fix xong!',
          message: `${rootCause}. ${filesFixed.length} file(s) da sua.${restartResult?.localUrl ? ' App: ' + restartResult.localUrl : ''}`,
          payload: { rootCause, filesFixed },
        });

        this.orch._emit('qa:fix_progress', { sprintId: null, phase: 'done', message: 'Bug da fix!' });
        return { status: 'FIXED', rootCause, filesFixed, localUrl: restartResult?.localUrl, attempt };
      }

      logger.warn({ attempt, newErrors: verifyParsed.data?.newErrors }, 'Verifier FAIL — retrying');
    }

    this.orch._emit('qa:fix_progress', { sprintId: null, phase: 'failed', message: 'Khong fix duoc sau 3 lan' });
    await this.orch.notif.send({
      projectId: project.id, type: 'pipeline_error',
      title: 'Bug chua fix duoc',
      message: `Khong tu dong fix duoc sau ${maxAttempts} lan. Can can thiep thu cong.`,
    });

    return { status: 'CANNOT_FIX', attempt: maxAttempts };
  }
}
