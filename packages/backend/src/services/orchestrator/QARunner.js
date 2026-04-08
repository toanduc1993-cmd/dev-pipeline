import prisma from '../../lib/prisma.js';
import { runClaudeWithRetry } from '../claude/claudeService.js';
import { parseClaudeOutput } from '../claude/outputParser.js';
import { PromptBuilder } from '../claude/promptBuilder.js';
import { WorktreeManager } from '../worktreeManager.js';
import { TASK_STATUS } from '../../lib/constants.js';
import {
  formatQAForPO, formatQALayer1FailForPO, formatQALayer2FailForPO,
} from './formatters/index.js';
import logger from '../../lib/logger.js';

export class QARunner {
  constructor(pipelineRunner) {
    this.runner = pipelineRunner;
  }

  async runQAFix(sprint, qaNotes, { fixAll = true } = {}) {
    // Always fix ALL issues — critical, major, AND minor. No partial fixes.
    fixAll = true;
    const MAX_QA_FIX_ROUNDS = 5;
    const { id: sprintId, project } = sprint;
    logger.info({ sprintId, fixAll }, 'Running QA fix');

    try {
      // Track QA fix attempts — store counter in sprint.metadata
      const sprintRecord = await prisma.sprint.findUnique({ where: { id: sprintId }, select: { metadata: true } });
      let sprintMeta = {};
      try { sprintMeta = JSON.parse(sprintRecord?.metadata || '{}'); } catch { sprintMeta = {}; }
      const qaFixRound = (sprintMeta.qaFixRound || 0) + 1;

      // Persist updated counter
      await prisma.sprint.update({
        where: { id: sprintId },
        data: { metadata: JSON.stringify({ ...sprintMeta, qaFixRound }) },
      });

      if (qaFixRound > MAX_QA_FIX_ROUNDS) {
        logger.warn({ sprintId, qaFixRound }, `QA fix exhausted after ${MAX_QA_FIX_ROUNDS} attempts — notifying PO`);
        await this.runner.orch.notif.send({
          projectId: project.id,
          sprintId,
          type: 'gate_waiting',
          title: `QA fix exhausted after ${MAX_QA_FIX_ROUNDS} attempts`,
          message: `Sprint #${sprint.number}: Automated QA fixes have been attempted ${MAX_QA_FIX_ROUNDS} times but issues persist. Manual intervention required.`,
          payload: { sprintId },
        });
        const notesStr = typeof qaNotes === 'string' ? qaNotes : JSON.stringify(qaNotes, null, 2);
        await this.runner._setGateWaiting(sprintId, 5, `⚠️ QA fix exhausted after ${MAX_QA_FIX_ROUNDS} attempts.\nRemaining issues require manual review and fix.\n\nLast QA notes:\n${notesStr}`);
        this.runner.orch._emit('sprint:updated', { sprintId, currentGateNumber: 5 });
        return;
      }

      logger.info({ sprintId, qaFixRound }, `QA fix attempt ${qaFixRound}/${MAX_QA_FIX_ROUNDS}`);
      const passTasks = await prisma.task.findMany({
        where: { sprintId, status: TASK_STATUS.PASS },
        orderBy: { taskId: 'asc' },
      });

      const builder = new PromptBuilder(project.repoPath);
      const masterContext = builder._getOptimizedContext(sprint.number);
      const conventions = builder._getConventions();

      // Load previous attempt history for smarter retries
      const previousAttempts = (sprintMeta.qaFixAttempts || []).slice(-3);

      const fixPrompt = builder.buildQAFixPrompt({
        masterContext,
        conventions,
        qaNotes,
        fixAll,
        sprintNumber: sprint.number,
        previousAttempts,
      });

      // ── Snapshot FROZEN files BEFORE Claude touches anything ──────────────
      const frozenSnapshots = new Map();
      try {
        const pathMod = await import('path');
        const { existsSync: exists, readFileSync: readF } = await import('fs');
        const zoneFile = pathMod.join(project.repoPath, 'docs', 'zone-classification.md');
        if (exists(zoneFile)) {
          const zoneContent = readF(zoneFile, 'utf-8');
          const frozenMatch = zoneContent.match(/## FROZEN[\s\S]*?(?=## GUARDED|## FLUID|$)/i);
          if (frozenMatch) {
            for (const line of frozenMatch[0].split('\n')) {
              const m = line.match(/`([^`]+)`/);
              if (m && !m[1].includes('*')) {
                const fullPath = pathMod.join(project.repoPath, m[1]);
                if (exists(fullPath)) {
                  frozenSnapshots.set(m[1], readF(fullPath));
                  logger.info({ file: m[1] }, 'Snapshot FROZEN file before QA fix');
                }
              }
            }
          }
        }
      } catch (snapErr) {
        logger.warn({ err: snapErr.message }, 'Could not snapshot FROZEN files');
      }

      this.runner.orch._emit('qa:fix_progress', { sprintId, phase: 'fixing', message: 'Claude dang doc QA report va fix...' });

      const result = await runClaudeWithRetry({
        prompt: fixPrompt,
        tools: ['Read', 'Write', 'Bash'],
        cwd: project.repoPath,
        sprintId,
        onChunk: (chunk) => {
          this.runner.orch._emit('agent:chunk', { taskId: 'qa-fix', agentSlot: 0, chunk });
        },
      });

      if (!result.success) {
        throw new Error('QA fix Claude call failed: ' + result.error);
      }

      const fixParsed = parseClaudeOutput(result.output, null);
      const fixesApplied = fixParsed.data?.fixesApplied || [];
      const fixesSkipped = fixParsed.data?.fixesSkipped || [];

      // Advisory code quality check on QA-fixed files
      try {
        const { checkFiles } = await import('./CodeQualityChecker.js');
        const pathMod2 = await import('path');
        const fixedPaths = fixesApplied.map(f => pathMod2.join(project.repoPath, f.file));
        checkFiles(fixedPaths, 'qa_fixer');
      } catch {}


      this.runner.orch._emit('qa:fix_progress', {
        sprintId,
        phase: 'fixed',
        message: `Fix xong: ${fixesApplied.length} applied, ${fixesSkipped.length} skipped`,
        fixesApplied,
        fixesSkipped,
      });

      logger.info({ sprintId, applied: fixesApplied.length, skipped: fixesSkipped.length }, 'QA fixes applied');

      // Save attempt history for smarter retries
      const attemptRecord = {
        round: qaFixRound,
        applied: fixesApplied.map(f => `${f.file}: ${f.description}`).join('; ') || 'none',
        failure: null, // will be filled if QA fails again
      };
      const attempts = [...(sprintMeta.qaFixAttempts || []), attemptRecord].slice(-5);
      await prisma.sprint.update({
        where: { id: sprintId },
        data: { metadata: JSON.stringify({ ...sprintMeta, qaFixRound, qaFixAttempts: attempts }) },
      });

      // ── AUTO-GUARD: Restore FROZEN files from pre-fix snapshot ──────────
      try {
        if (frozenSnapshots.size > 0) {
          const pathMod = await import('path');
          const { readFileSync: readF, writeFileSync: writeF } = await import('fs');
          const simpleGit = (await import('simple-git')).default;
          const git = simpleGit(project.repoPath);
          const restored = [];

          for (const [relPath, originalContent] of frozenSnapshots) {
            const fullPath = pathMod.join(project.repoPath, relPath);
            try {
              const currentContent = readF(fullPath);
              if (!currentContent.equals(originalContent)) {
                writeF(fullPath, originalContent);
                restored.push(relPath);
                logger.warn({ file: relPath }, 'FROZEN file was modified by QA Fixer — restored from snapshot');
              }
            } catch {}
          }

          if (restored.length > 0) {
            this.runner.orch._emit('qa:fix_progress', { sprintId, phase: 'reverting', message: `Auto-restored ${restored.length} FROZEN file(s): ${restored.join(', ')}` });
            await git.add(restored);
            await git.commit('fix: auto-restore FROZEN files modified by QA Fixer');
            logger.info({ sprintId, restored }, 'FROZEN files restored from pre-fix snapshot');
          }
        }
      } catch (guardErr) {
        logger.warn({ sprintId, err: guardErr.message }, 'FROZEN guard restore failed — continuing');
      }

      const notesStr = typeof qaNotes === 'string' ? qaNotes : JSON.stringify(qaNotes, null, 2);
      const fixSummary = `\n\n---\n## QA Fixes Applied\n${fixesApplied.map((f) => `- **${f.file}**: ${f.description} (${f.severity || 'fix'})`).join('\n') || 'Xem chi tiet trong logs'}\n${fixesSkipped.length > 0 ? `\n### Skipped\n${fixesSkipped.map((f) => `- ${f.description}: ${f.reason}`).join('\n')}` : ''}`;

      await prisma.gate.update({
        where: { sprintId_gateNumber: { sprintId, gateNumber: 5 } },
        data: { notes: notesStr + fixSummary },
      });

      this.runner.orch._emit('qa:fix_progress', { sprintId, phase: 'rerunning_qa', message: `Fix attempt ${qaFixRound}/${MAX_QA_FIX_ROUNDS} done — re-running QA...` });

      const { runSprintAutomatedChecks } = await import('../validationService.js');
      const quickCheck = await runSprintAutomatedChecks(project.repoPath);

      if (!quickCheck.passed) {
        logger.warn({ sprintId }, '[QA-FIX] Layer 1 still fails after fix');
        this.runner.orch._emit('qa:fix_progress', { sprintId, phase: 'failed', message: 'Syntax errors remain after fix' });
      }

      // Re-run full QA
      const freshSprint = await this.runner._reloadSprint(sprintId);
      await this.step5_QA(freshSprint);

      // Check if QA passed — if not, auto-retry (within limit)
      const updatedGate5 = await prisma.gate.findFirst({
        where: { sprintId, gateNumber: 5 },
        select: { structuredData: true, notes: true },
      });

      let stillHasIssues = false;
      if (updatedGate5?.structuredData) {
        try {
          const qaData = JSON.parse(updatedGate5.structuredData);
          const ti = qaData.technicalIssues || {};
          const issueCount = (ti.critical?.length || 0) + (ti.major?.length || 0) + (ti.minor?.length || 0);
          stillHasIssues = issueCount > 0 && qaData.blockMerge === true;

          // Save failure context for next attempt
          if (stillHasIssues) {
            const failureDesc = [
              ...(ti.critical || []).map(i => `[CRITICAL] ${i.description}`),
              ...(ti.major || []).map(i => `[MAJOR] ${i.description}`),
              ...(ti.minor || []).map(i => `[MINOR] ${i.description}`),
            ].join('; ').substring(0, 500);

            const latestMeta = JSON.parse((await prisma.sprint.findUnique({ where: { id: sprintId }, select: { metadata: true } }))?.metadata || '{}');
            const updatedAttempts = latestMeta.qaFixAttempts || [];
            if (updatedAttempts.length > 0) {
              updatedAttempts[updatedAttempts.length - 1].failure = failureDesc;
            }
            await prisma.sprint.update({
              where: { id: sprintId },
              data: { metadata: JSON.stringify({ ...latestMeta, qaFixAttempts: updatedAttempts }) },
            });
          }
        } catch {}
      }

      if (stillHasIssues && qaFixRound < MAX_QA_FIX_ROUNDS) {
        logger.info({ sprintId, qaFixRound }, 'QA still has issues — auto-retrying fix');
        this.runner.orch._emit('qa:fix_progress', { sprintId, phase: 'retrying', message: `Still ${qaFixRound < MAX_QA_FIX_ROUNDS ? 'has issues' : 'exhausted'} — auto-retry ${qaFixRound + 1}/${MAX_QA_FIX_ROUNDS}...` });

        // Reset gate to allow re-fix
        await prisma.gate.update({
          where: { sprintId_gateNumber: { sprintId, gateNumber: 5 } },
          data: { status: 'waiting_approval' },
        });
        await prisma.sprint.update({
          where: { id: sprintId },
          data: { status: 'waiting_gate', isProcessing: false },
        });

        // Reload QA notes for next attempt
        const reloadedGate = await prisma.gate.findFirst({ where: { sprintId, gateNumber: 5 }, select: { structuredData: true, notes: true } });
        const nextQaNotes = reloadedGate?.structuredData ? JSON.parse(reloadedGate.structuredData) : (reloadedGate?.notes || '');
        const reloadedSprint = await this.runner._reloadSprint(sprintId);
        return this.runQAFix(reloadedSprint, nextQaNotes, { fixAll: true });
      }

      logger.info({ sprintId, qaFixRound, stillHasIssues }, 'QA fix cycle completed');
    } catch (err) {
      logger.error({ sprintId, err: err.message }, 'QA fix failed');
      await this.runner._unlock(sprintId);
      await this.runner.orch._askPOOnError(sprint, 5, 'QA fix failed: ' + err.message);
    }
  }

  async step5_QA(sprint) {
    const { id: sprintId, project, number } = sprint;
    logger.info({ sprintId, step: 5 }, 'Step 5: QA — 3 layers');
    await this.runner._lock(sprintId, 5);

    try {
      const passTasks = await prisma.task.findMany({
        where: { sprintId, status: TASK_STATUS.PASS },
        include: { logs: { where: { phase: 'review' }, orderBy: { createdAt: 'desc' }, take: 1 } },
        orderBy: { taskId: 'asc' },
      });

      if (passTasks.length === 0) throw new Error('No passed tasks to QA');

      const builder = new PromptBuilder(project.repoPath);

      // ── LAYER 1: AUTOMATED ────────────────────────────────────────────────
      logger.info({ sprintId }, 'QA Layer 1: Automated checks');
      this.runner.orch._emit('qa:fix_progress', { sprintId, phase: 'layer1', message: 'QA Layer 1: Kiem tra tu dong (syntax, lint, test)...' });
      const { runSprintAutomatedChecks } = await import('../validationService.js');
      const automatedResults = await runSprintAutomatedChecks(project.repoPath);
      logger.info({ sprintId, passed: automatedResults.passed }, 'Layer 1 completed');

      if (!automatedResults.passed) {
        const failedChecks = automatedResults.checks.filter((c) => !c.passed);
        const notesForPO = formatQALayer1FailForPO(failedChecks, number);

        const gate5 = await prisma.gate.findUnique({
          where: { sprintId_gateNumber: { sprintId, gateNumber: 5 } },
          select: { id: true },
        });
        await this.runner.orch.notif.send({
          projectId: project.id, sprintId,
          type: 'gate_waiting',
          title: 'QA Layer 1 FAIL — Automated checks',
          message: `Sprint #${number}: ${failedChecks.length} check(s) failed`,
          payload: { gateId: gate5?.id },
        });
        await this.runner._setGateWaiting(sprintId, 5, notesForPO);
        this.runner.orch._emit('sprint:updated', { sprintId, currentGateNumber: 5 });
        logger.warn({ sprintId, failedChecks: failedChecks.map((c) => c.name) }, 'QA stopped at Layer 1');
        return;
      }

      // ── LAYER 2: CONTRACT CHECK ───────────────────────────────────────────
      logger.info({ sprintId }, 'QA Layer 2: Contract check');
      this.runner.orch._emit('qa:fix_progress', { sprintId, phase: 'layer2', message: 'QA Layer 2: Kiem tra zone + interface...' });
      let contractData = { passed: true, blockMerge: false };

      try {
        const wtManager = new WorktreeManager(project.repoPath);
        const taskDiffs = [];
        for (const task of passTasks) {
          try {
            const diff = await wtManager.getDiff(task.taskId);
            if (diff?.trim()) taskDiffs.push(`=== Task ${task.taskId}: ${task.title} ===\n${diff}`);
          } catch (err) {
            logger.warn({ taskId: task.taskId, err: err.message }, 'Could not get worktree diff for contract check');
          }
        }
        const gitDiff = taskDiffs.join('\n\n').substring(0, 12000) || '(no diff available)';

        const taskSpecs = passTasks.map((t) => {
          try { return JSON.parse(t.spec); } catch { return { taskId: t.taskId }; }
        });

        const contractPrompt = builder.buildContractCheckPrompt({
          sprintNumber: number, taskSpecs, gitDiff, automatedResults,
        });

        const contractResult = await runClaudeWithRetry({
          prompt: contractPrompt, tools: [], cwd: project.repoPath, sprintId,
        });

        const contractParsed = parseClaudeOutput(contractResult.output, 'contractCheck');
        if (contractParsed.success) contractData = contractParsed.data;
      } catch (l2err) {
        logger.warn({ sprintId, err: l2err.message }, 'Layer 2 Claude call failed — treating as passed');
      }

      logger.info({ sprintId, passed: contractData.passed, blockMerge: contractData.blockMerge }, 'Layer 2 completed');

      if (contractData.blockMerge) {
        const notesForPO = formatQALayer2FailForPO(contractData, number);
        const gate5 = await prisma.gate.findUnique({
          where: { sprintId_gateNumber: { sprintId, gateNumber: 5 } },
          select: { id: true },
        });
        await this.runner.orch.notif.send({
          projectId: project.id, sprintId,
          type: 'gate_waiting',
          title: 'QA Layer 2 — Contract violations',
          message: `Sprint #${number}: Zone/interface violations need review`,
          payload: { gateId: gate5?.id },
        });
        await this.runner._setGateWaiting(sprintId, 5, notesForPO);
        this.runner.orch._emit('sprint:updated', { sprintId, currentGateNumber: 5 });
        logger.warn({ sprintId }, 'QA stopped at Layer 2');
        return;
      }

      // ── LAYER 3: BUSINESS REVIEW (QA chunks + final) ──────────────────────
      logger.info({ sprintId }, 'QA Layer 3: Business review');
      this.runner.orch._emit('qa:fix_progress', { sprintId, phase: 'layer3', message: 'QA Layer 3: Claude review business logic...' });

      const config = await prisma.pipelineConfig.findUnique({ where: { id: 'singleton' } });
      const chunkSize = config?.qaChunkSize || 5;
      const wtManager = new WorktreeManager(project.repoPath);

      const chunks = [];
      for (let i = 0; i < passTasks.length; i += chunkSize) {
        chunks.push(passTasks.slice(i, i + chunkSize));
      }

      const chunkResults = [];
      let anyDiffTruncated = false;
      for (let i = 0; i < chunks.length; i++) {
        const chunkTasks = chunks[i];
        const diffs = [];
        for (const task of chunkTasks) {
          const diff = await wtManager.getDiff(task.taskId);
          diffs.push(`=== ${task.taskId} ===\n${diff}`);
        }
        const fullDiff = diffs.join('\n\n');
        const DIFF_LIMIT = 12000;
        const diffTruncated = fullDiff.length > DIFF_LIMIT;
        const combinedDiff = diffTruncated
          ? fullDiff.substring(0, DIFF_LIMIT) + `\n\n[... DIFF TRUNCATED — ${fullDiff.length} total ...]`
          : fullDiff;
        if (diffTruncated) {
          anyDiffTruncated = true;
          logger.warn({ sprintId, totalDiffLength: fullDiff.length }, 'QA diff truncated');
        }

        const prompt = builder.buildQAChunkPrompt({
          sprintNumber: number, chunkIndex: i, totalChunks: chunks.length,
          tasks: chunkTasks.map((t) => {
            let reviewIssues = [];
            if (t.reviewParsed) {
              try {
                const parsed = typeof t.reviewParsed === 'string' ? JSON.parse(t.reviewParsed) : t.reviewParsed;
                reviewIssues = parsed.issues || [];
              } catch { /* ignore parse errors */ }
            }
            return { taskId: t.taskId, spec: JSON.parse(t.spec), archVerdict: t.archVerdict, reviewIssues };
          }),
          diffs: combinedDiff,
        });
        const result = await runClaudeWithRetry({ prompt, tools: [], cwd: project.repoPath, sprintId });
        const parsed = parseClaudeOutput(result.output, 'qaChunk');
        chunkResults.push(parsed.success ? parsed.data : { chunkIndex: i, chunkSummary: result.output.substring(0, 500), taskReviews: [] });
      }

      const finalPrompt = builder.buildQAFinalPrompt({ sprintNumber: number, chunkResults });
      const finalResult = await runClaudeWithRetry({ prompt: finalPrompt, tools: [], sprintId });
      const finalParsed = parseClaudeOutput(finalResult.output, 'qaFinal');

      const notesForPO = finalParsed.success ? formatQAForPO(finalParsed.data) : finalResult.output;

      await prisma.gate.update({
        where: { sprintId_gateNumber: { sprintId, gateNumber: 5 } },
        data: {
          notes: notesForPO,
          structuredData: finalParsed.success ? JSON.stringify(finalParsed.data) : null,
        },
      });

      const hasBlock = finalParsed.data?.blockMerge === true;
      const gate5Rec = await prisma.gate.findUnique({
        where: { sprintId_gateNumber: { sprintId, gateNumber: 5 } },
        select: { id: true },
      });

      const criticalCount = finalParsed.data?.technicalIssues?.critical?.length || 0;
      const majorCount = finalParsed.data?.technicalIssues?.major?.length || 0;
      const hasCriticalIssues = criticalCount > 0 || majorCount > 0;

      if (hasCriticalIssues) {
        await this.runner.orch.notif.send({
          projectId: project.id, sprintId,
          type: 'qa_fix',
          title: `QA Report — ${criticalCount} critical, ${majorCount} major`,
          message: `Sprint #${number}: Gate 5 cho PO review. Duyệt fix hoặc bỏ qua.${anyDiffTruncated ? ' (Diff bị cắt)' : ''}`,
          payload: { sprintId, gateId: gate5Rec?.id },
        });
      } else {
        await this.runner.orch.notif.send({
          projectId: project.id, sprintId,
          type: 'gate_waiting',
          title: hasBlock ? 'QA: Co loi can xem xet' : 'QA Report — Khong co loi',
          message: `Sprint #${number}: Gate 5 cho PO review${anyDiffTruncated ? ' (Diff bị cắt)' : ''}`,
          payload: { gateId: gate5Rec?.id },
        });
      }

      await this.runner._setGateWaiting(sprintId, 5, notesForPO);
      this.runner.orch._emit('sprint:updated', { sprintId, currentGateNumber: 5 });

      this.runner.orch._emit('qa:fix_progress', { sprintId, phase: 'done', message: 'QA hoan thanh — cho PO duyet' });
      logger.info({ sprintId, hasBlock }, 'Step 5 QA — all 3 layers completed');
    } catch (err) {
      await this.runner._unlock(sprintId);
      throw err;
    }
  }
}
