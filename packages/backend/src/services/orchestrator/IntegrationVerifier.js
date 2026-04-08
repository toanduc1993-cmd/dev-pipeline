import prisma from '../../lib/prisma.js';
import { runClaudeWithRetry } from '../claude/claudeService.js';
import { parseClaudeOutput } from '../claude/outputParser.js';
import { PromptBuilder } from '../claude/promptBuilder.js';
import { TASK_STATUS } from '../../lib/constants.js';
import { extractJSONFromNotes } from './formatters/utils.js';
import path from 'path';
import logger from '../../lib/logger.js';

export class IntegrationVerifier {
  constructor(pipelineRunner) {
    this.runner = pipelineRunner;
  }

  async verify(sprint) {
    const { id: sprintId, project, number } = sprint;
    logger.info({ sprintId }, 'Step 4.5: Integration Verification');

    try {
      const gate1 = await prisma.gate.findUnique({ where: { sprintId_gateNumber: { sprintId, gateNumber: 1 } } });
      const gate2 = await prisma.gate.findUnique({ where: { sprintId_gateNumber: { sprintId, gateNumber: 2 } } });

      const architectSpec = (gate1?.structuredData ? JSON.parse(gate1.structuredData) : extractJSONFromNotes(gate1?.notes)) || {};
      const featureSpecs = (gate2?.structuredData ? JSON.parse(gate2.structuredData) : extractJSONFromNotes(gate2?.notes)) || {};

      const passTasks = await prisma.task.findMany({ where: { sprintId, status: TASK_STATUS.PASS }, orderBy: { taskId: 'asc' } });
      const taskSpecs = passTasks.map((t) => { try { return JSON.parse(t.spec); } catch { return { taskId: t.taskId, title: t.title }; } });

      const { exec } = await import('child_process');
      const { promisify } = await import('util');
      const execAsync = promisify(exec);

      let fileTree = '';
      try {
        const { stdout } = await execAsync('find . -type f -not -path "./.git/*" -not -path "./node_modules/*" -not -path "./__pycache__/*" | sort', { cwd: project.repoPath, timeout: 10000 });
        fileTree = stdout.substring(0, 5000);
      } catch { fileTree = '[Could not read file tree]'; }

      let testOutput = null;
      try {
        const { existsSync } = await import('fs');
        const hasPackageJson = existsSync(path.join(project.repoPath, 'package.json'));
        const hasRequirements = existsSync(path.join(project.repoPath, 'requirements.txt'));
        if (hasPackageJson) {
          try { const { stdout, stderr } = await execAsync('npm test 2>&1 || true', { cwd: project.repoPath, timeout: 60000 }); testOutput = (stdout + stderr).substring(0, 5000); }
          catch (e) { testOutput = `npm test error: ${e.message}`; }
        } else if (hasRequirements) {
          try { const { stdout, stderr } = await execAsync('python3 -m pytest --tb=short 2>&1 || true', { cwd: project.repoPath, timeout: 60000 }); testOutput = (stdout + stderr).substring(0, 5000); }
          catch (e) { testOutput = `pytest error: ${e.message}`; }
        }
      } catch {}

      const builder = new PromptBuilder(project.repoPath);
      const prompt = builder.buildIntegrationVerifyPrompt({ architectSpec, featureSpecs, taskSpecs, fileTree, testOutput });

      const result = await runClaudeWithRetry({ prompt, tools: [], cwd: project.repoPath, sprintId });
      if (!result.success) throw new Error('Integration verify failed: ' + result.error);

      const parsed = parseClaudeOutput(result.output, 'integrationVerify');
      if (!parsed.success) {
        logger.warn({ sprintId }, 'Could not parse verify output — proceeding to QA');
        return 'proceed';
      }

      const verifyData = parsed.data;
      logger.info({ sprintId, overallStatus: verifyData.overallStatus, fixCount: verifyData.fixes?.length || 0 }, 'Integration verify result');

      if (verifyData.overallStatus === 'PASS') return 'proceed';

      const criticalFixes = (verifyData.fixes || []).filter((f) => f.priority === 'critical' || f.priority === 'major');
      if (criticalFixes.length === 0) return 'proceed';

      // Auto-fix
      logger.info({ sprintId, fixCount: criticalFixes.length }, 'Integration issues — running auto-fix');
      const fixPrompt = builder.buildIntegrationFixPrompt({ verifyResult: verifyData, architectSpec, taskSpecs, sprintNumber: number });
      const fixResult = await runClaudeWithRetry({ prompt: fixPrompt, tools: ['Read', 'Write', 'Bash'], cwd: project.repoPath, sprintId });

      if (passTasks.length > 0) {
        await prisma.agentLog.create({
          data: { taskId: passTasks[0].id, round: 0, phase: 'integration_fix', promptLength: fixPrompt.length, rawOutput: fixResult.output, success: fixResult.success, durationMs: fixResult.durationMs },
        });
      }

      return 'proceed';
    } catch (err) {
      logger.error({ sprintId, err: err.message }, 'Integration verify failed — proceeding without integration check');
      try {
        await this.runner.orch.notif.send({
          projectId: project.id,
          sprintId,
          type: 'warn',
          title: '⚠️ Integration verify skipped',
          message: `IntegrationVerifier threw an exception and was bypassed. Error: ${err.message}`,
          payload: { sprintId },
        });
      } catch (notifErr) {
        logger.warn({ notifErr: notifErr.message }, 'Failed to send IntegrationVerifier skip notification');
      }
      return 'proceed';
    }
  }
}
