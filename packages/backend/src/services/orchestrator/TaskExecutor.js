import prisma from '../../lib/prisma.js';
import { runClaudeWithRetry } from '../claude/claudeService.js';
import { parseClaudeOutput } from '../claude/outputParser.js';
import { PromptBuilder } from '../claude/promptBuilder.js';
import { WorktreeManager } from '../worktreeManager.js';
import { validateTask } from '../validationService.js';
import { TASK_STATUS, SPRINT_STATUS, TASK_TIMEOUT_MS } from '../../lib/constants.js';
import logger from '../../lib/logger.js';

export class TaskExecutor {
  constructor(orchestrator) {
    this.orch = orchestrator;
  }

  async executeTask(task, { wtManager, builder, sprint, maxRetry }) {
    const timeoutMs = TASK_TIMEOUT_MS || 45 * 60 * 1000;

    const taskExecution = this._executeTaskInner(task, { wtManager, builder, sprint, maxRetry });
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`Task timed out after ${Math.round(timeoutMs / 60000)} minutes`)), timeoutMs)
    );

    try {
      await Promise.race([taskExecution, timeoutPromise]);
    } catch (err) {
      if (err.message.includes('Task timed out')) {
        logger.error({ taskId: task.taskId, timeoutMs }, 'Task execution timed out');
        await this.escalateTask(task, err.message);
      } else {
        throw err;
      }
    }
  }

  async _executeTaskInner(task, { wtManager, builder, sprint, maxRetry }) {
    const { project } = sprint;
    const taskSpec = JSON.parse(task.spec);

    logger.info({ taskId: task.taskId, agentSlot: task.agentSlot }, 'Executing task');

    // Setup worktree
    let branch, worktreePath;
    try {
      ({ branch, worktreePath } = await wtManager.createWorktree(task.taskId));
      await prisma.task.update({
        where: { id: task.id },
        data: { branch, worktreePath, status: TASK_STATUS.RUNNING, startedAt: new Date() },
      });
      this.orch._emit('task:updated', { taskId: task.id, status: TASK_STATUS.RUNNING, agentSlot: task.agentSlot });
    } catch (err) {
      logger.error({ err: err.message, taskId: task.taskId }, 'Worktree creation failed');
      await this.escalateTask(task, `Worktree creation failed: ${err.message}`);
      return;
    }

    const masterContext = builder._getOptimizedContext(sprint.number);
    const conventions = builder._getConventions();
    const repoInfo = `Repo: ${project.repoPath}\nBranch: ${branch}\nWorktree: ${worktreePath}`;

    for (let round = 1; round <= maxRetry; round++) {
      await prisma.task.update({ where: { id: task.id }, data: { currentRound: round } });

      // PHASE 1: DEV
      await prisma.task.update({ where: { id: task.id }, data: { status: TASK_STATUS.RUNNING } });
      this.orch._emit('task:updated', { taskId: task.id, status: TASK_STATUS.RUNNING, round });

      if (round > 1 && taskSpec._fixInstructions) {
        taskSpec._retryNote = `ROUND ${round} RETRY. Cac van de ky thuat can fix (phat hien boi automated checks):\n${taskSpec._fixInstructions.map((f) => `- [${f.severity}] ${f.description}`).join('\n')}`;
      }

      const devPrompt = builder.buildDeveloperPrompt({ task: taskSpec, masterContext, conventions, repoInfo });
      const devResult = await runClaudeWithRetry({
        prompt: devPrompt, tools: ['Read', 'Write', 'Bash', 'TodoWrite', 'TodoRead'],
        cwd: worktreePath, sprintId: sprint.id,
        onChunk: (chunk) => this.orch._emit('agent:chunk', { taskId: task.id, agentSlot: task.agentSlot, chunk }),
      });

      await prisma.agentLog.create({
        data: { taskId: task.id, round, phase: 'dev', promptLength: devPrompt.length, rawOutput: devResult.output, success: devResult.success, errorMsg: devResult.error || null, durationMs: devResult.durationMs },
      });

      if (!devResult.success) {
        if (round === maxRetry) { await this.escalateTask(task, `Claude dev call failed after ${maxRetry} rounds: ${devResult.error}`); return; }
        continue;
      }

      const devParsed = parseClaudeOutput(devResult.output, 'devReport');
      await prisma.task.update({ where: { id: task.id }, data: { devOutputRaw: devResult.output, devOutputParsed: devParsed.success ? JSON.stringify(devParsed.data) : null } });

      // PHASE 2: VALIDATION
      await prisma.task.update({ where: { id: task.id }, data: { status: TASK_STATUS.VALIDATING } });
      this.orch._emit('task:updated', { taskId: task.id, status: TASK_STATUS.VALIDATING, round });

      const validationResult = await validateTask(worktreePath, taskSpec);
      await prisma.task.update({ where: { id: task.id }, data: { validationResult: JSON.stringify(validationResult) } });
      await prisma.agentLog.create({ data: { taskId: task.id, round, phase: 'validation', rawOutput: JSON.stringify(validationResult), success: validationResult.passed } });

      if (!validationResult.passed) {
        logger.warn({ taskId: task.taskId, errors: validationResult.errors }, 'Validation failed');
        if (round === maxRetry) { await this.escalateTask(task, `Validation failed after ${maxRetry} rounds: ${validationResult.errors.join('; ')}`); return; }
        taskSpec._fixInstructions = validationResult.errors.map((e) => ({ severity: 'critical', description: e }));
        continue;
      }

      // PHASE 3: REVIEW
      await prisma.task.update({ where: { id: task.id }, data: { status: TASK_STATUS.REVIEWING } });
      this.orch._emit('task:updated', { taskId: task.id, status: TASK_STATUS.REVIEWING, round });

      const gitDiff = await wtManager.getDiff(task.taskId);
      const reviewPrompt = builder.buildReviewPrompt({ task: taskSpec, gitDiff, validationResult });
      const reviewResult = await runClaudeWithRetry({ prompt: reviewPrompt, tools: [], cwd: project.repoPath, sprintId: sprint.id });
      const reviewParsed = parseClaudeOutput(reviewResult.output, 'review');

      await prisma.agentLog.create({
        data: { taskId: task.id, round, phase: 'review', promptLength: reviewPrompt.length, rawOutput: reviewResult.output, parsedOutput: reviewParsed.success ? JSON.stringify(reviewParsed.data) : null, success: reviewResult.success, durationMs: reviewResult.durationMs },
      });

      const verdict = reviewParsed.data?.verdict || 'FAIL';
      await prisma.task.update({ where: { id: task.id }, data: { reviewOutputRaw: reviewResult.output, reviewParsed: reviewParsed.success ? JSON.stringify(reviewParsed.data) : null, archVerdict: verdict } });

      if (verdict === 'PASS' || verdict === 'PASS_WITH_NOTES') {
        await prisma.task.update({ where: { id: task.id }, data: { status: TASK_STATUS.PASS, completedAt: new Date() } });
        this.orch._emit('task:updated', { taskId: task.id, status: TASK_STATUS.PASS, verdict });
        logger.info({ taskId: task.taskId, verdict, round }, 'Task PASS');
        return;
      } else if (round < maxRetry) {
        const issues = reviewParsed.data?.issues || [];
        taskSpec._fixInstructions = issues.map((i) => ({ severity: i.severity || 'major', description: `${i.file ? i.file + ': ' : ''}${i.description}${i.fix ? ' — fix: ' + i.fix : ''}` }));
        if (taskSpec._fixInstructions.length === 0) taskSpec._fixInstructions = [{ severity: 'major', description: 'Code chua dat yeu cau spec. Xem lai implementation.' }];
        this.orch._emit('task:updated', { taskId: task.id, status: TASK_STATUS.RUNNING, round: round + 1 });
        continue;
      } else {
        await this.escalateTask(task, `FAIL after ${maxRetry} rounds. Last verdict: ${verdict}`);
        return;
      }
    }
  }

  async escalateTask(task, reason) {
    await prisma.task.update({ where: { id: task.id }, data: { status: TASK_STATUS.ESCALATED, escalationReason: reason } });
    this.orch._emit('task:updated', { taskId: task.id, status: TASK_STATUS.ESCALATED });
    logger.warn({ taskId: task.taskId, reason }, 'Task escalated');
  }

  async retryTask(taskId, sprint) {
    const { id: sprintId, project } = sprint;
    try {
      const task = await prisma.task.findUnique({ where: { id: taskId } });
      if (!task) throw new Error(`Task ${taskId} not found`);
      const config = await prisma.pipelineConfig.findUnique({ where: { id: 'singleton' } });
      const maxRetry = config?.maxRetryRounds || 3;
      const wtManager = new WorktreeManager(project.repoPath);
      const builder = new PromptBuilder(project.repoPath);
      await this.executeTask(task, { wtManager, builder, sprint, maxRetry });
      const updatedTask = await prisma.task.findUnique({ where: { id: taskId } });
      if (updatedTask.status === TASK_STATUS.PASS) {
        await this.orch.resumeAfterHumanOverride(sprintId);
      } else {
        await prisma.sprint.update({ where: { id: sprintId }, data: { isProcessing: false, status: SPRINT_STATUS.WAITING_HUMAN } });
      }
    } catch (err) {
      logger.error({ taskId, sprintId, err: err.message }, 'retryTask failed');
      await prisma.sprint.update({ where: { id: sprintId }, data: { isProcessing: false } });
    }
  }
}
