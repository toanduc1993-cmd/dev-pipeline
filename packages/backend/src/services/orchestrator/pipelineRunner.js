import prisma from '../../lib/prisma.js';
import { runClaudeWithRetry, killProcess } from '../claude/claudeService.js';
import { parseClaudeOutput } from '../claude/outputParser.js';
import { PromptBuilder } from '../claude/promptBuilder.js';
import { WorktreeManager } from '../worktreeManager.js';
import { SPRINT_STATUS, GATE_STATUS, TASK_STATUS } from '../../lib/constants.js';
import { promises as fs } from 'fs';
import path from 'path';
import logger from '../../lib/logger.js';
import {
  formatReceptionForPO, formatArchitectForPO, formatFeatureSpecsForPO,
  formatTasksForPO, extractJSONFromNotes,
} from './formatters/index.js';
import { DeployRunner } from './DeployRunner.js';
import { BugfixRunner } from './BugfixRunner.js';
import { IntegrationVerifier } from './IntegrationVerifier.js';
import { TaskExecutor } from './TaskExecutor.js';
import { QARunner } from './QARunner.js';

export class PipelineRunner {
  constructor(orchestrator) {
    this.orch = orchestrator;
    this._deploy = new DeployRunner(orchestrator);
    this._bugfix = new BugfixRunner(orchestrator, this._deploy);
    this._integrationVerifier = new IntegrationVerifier(this);
    this._taskExecutor = new TaskExecutor(orchestrator);
    this._qaRunner = new QARunner(this);
  }

  // ─── LOCK HELPERS ──────────────────────────────────────────────────────────

  async _lock(sprintId, step) {
    await prisma.sprint.update({
      where: { id: sprintId },
      data: { isProcessing: true, currentStep: step, status: SPRINT_STATUS.RUNNING_STEP },
    });
  }

  async _unlock(sprintId) {
    await prisma.sprint.update({
      where: { id: sprintId },
      data: { isProcessing: false },
    });
  }

  async _setGateWaiting(sprintId, gateNumber, notes = null) {
    await prisma.gate.update({
      where: { sprintId_gateNumber: { sprintId, gateNumber } },
      data: { status: GATE_STATUS.WAITING_APPROVAL, notes },
    });
    await prisma.sprint.update({
      where: { id: sprintId },
      data: {
        status: SPRINT_STATUS.WAITING_GATE,
        currentGateNumber: gateNumber,
        isProcessing: false,
      },
    });
  }

  killActiveProcess(sprintId) {
    return killProcess(sprintId);
  }

  async _reloadSprint(sprintId) {
    const sprint = await prisma.sprint.findUnique({
      where: { id: sprintId },
      include: { project: true },
    });
    if (!sprint) throw new Error(`Sprint ${sprintId} not found`);
    return sprint;
  }

  // ─── STEP ROUTER ───────────────────────────────────────────────────────────

  async runStep(sprint, stepNumber) {
    const steps = {
      1: this._step1_Architect,
      2: this._step2_FeatureSpecs,
      3: this._step3_AtomicTasks,
      4: this._step4_DeveloperAgents,
      5: (sprint) => this._qaRunner.step5_QA(sprint),
    };

    const fn = steps[stepNumber];
    if (!fn) throw new Error(`Unknown step: ${stepNumber}`);

    const freshSprint = await this._reloadSprint(sprint.id);
    await fn.call(this, freshSprint);
  }

  async runMerge(sprint) {
    const freshSprint = await this._reloadSprint(sprint.id);
    const { id: sprintId, project } = freshSprint;
    logger.info({ sprintId }, 'Executing merge');
    await this._lock(sprintId, 6);

    try {
      const passTasks = await prisma.task.findMany({
        where: { sprintId, status: TASK_STATUS.PASS },
        orderBy: { taskId: 'asc' },
      });

      const wtManager = new WorktreeManager(project.repoPath);
      const mergeErrors = [];

      for (const task of passTasks) {
        try {
          await wtManager.mergeToMain(task.taskId, task.branch);
          logger.info({ taskId: task.taskId }, 'Merged successfully');
        } catch (err) {
          mergeErrors.push({ taskId: task.taskId, error: err.message });
          logger.error({ err: err.message, taskId: task.taskId }, 'Merge failed');
        }
      }

      if (mergeErrors.length > 0) {
        // Ask PO what to do instead of auto-failing
        await this._unlock(sprintId);
        throw new Error(`Merge conflict: ${mergeErrors.map((e) => `${e.taskId} — ${e.error.substring(0, 80)}`).join('; ')}`);
      }

      // Write breaking changes to registry
      try {
        const gate1 = await prisma.gate.findUnique({
          where: { sprintId_gateNumber: { sprintId, gateNumber: 1 } },
          select: { notes: true },
        });
        const architectData = gate1?.structuredData ? JSON.parse(gate1.structuredData) : extractJSONFromNotes(gate1?.notes);
        const breakingChanges = architectData?.breakingChanges || [];

        if (breakingChanges.length > 0) {
          const bcDir = path.join(project.repoPath, 'docs', 'contracts');
          const bcPath = path.join(bcDir, 'breaking-changes.md');

          await fs.mkdir(bcDir, { recursive: true });

          let existing = '';
          try { existing = await fs.readFile(bcPath, 'utf8'); } catch {
            existing = `# Breaking Change Registry\n> Tu dong cap nhat sau moi sprint.\n\n`;
          }

          const newEntries = breakingChanges.map((bc) => `
### Sprint #${freshSprint.number} — ${new Date().toISOString().split('T')[0]}
- **Type:** ${bc.type}
- **Description:** ${bc.description}
- **Affected:** ${(bc.affectedModules || []).join(', ')}
- **Migration:** ${bc.migrationRequired ? `Required — ${bc.migrationNotes}` : 'Not required'}
`).join('\n');

          await fs.writeFile(bcPath, existing + newEntries, 'utf8');
          logger.info({ sprintId, count: breakingChanges.length }, 'Breaking changes logged');
        }
      } catch (bcErr) {
        logger.warn({ sprintId, error: bcErr.message }, 'Failed to log breaking changes');
      }

      await wtManager.pruneAll();

      await prisma.sprint.update({
        where: { id: sprintId },
        data: { status: SPRINT_STATUS.COMPLETED, isProcessing: false },
      });

      await prisma.gate.update({
        where: { sprintId_gateNumber: { sprintId, gateNumber: 6 } },
        data: { status: GATE_STATUS.APPROVED, approvedAt: new Date(), approvedBy: 'web' },
      });

      this.orch._emit('sprint:updated', { sprintId, status: SPRINT_STATUS.COMPLETED });
      logger.info({ sprintId, taskCount: passTasks.length }, 'Merge completed');

      // Auto-run local setup after merge
      try {
        logger.info({ sprintId }, 'Running auto local setup after merge');
        const setupResult = await this.runLocalSetup(project);
        const setupOk = setupResult.success;

        await this.orch.notif.send({
          projectId: project.id, sprintId,
          type: 'sprint_complete',
          title: 'Sprint hoàn thành!',
          message: `${passTasks.length} tasks merged.${setupOk ? ` App chạy tại ${setupResult.localUrl || 'local'}` : ' Local setup có lỗi — kiểm tra Dashboard.'}`,
          payload: { localUrl: setupResult.localUrl, setupSteps: setupResult.steps },
        });
      } catch (setupErr) {
        logger.warn({ err: setupErr.message }, 'Auto local setup failed — sprint still completed');
        await this.orch.notif.send({
          projectId: project.id, sprintId,
          type: 'sprint_complete',
          title: 'Sprint hoàn thành!',
          message: `${passTasks.length} tasks merged. Local setup chưa chạy được — chạy thủ công trên Dashboard.`,
        });
      }
    } catch (err) {
      await this._unlock(sprintId);
      throw err;
    }
  }

  // ─── STEP 0: RECEPTION REPORT ───────────────────────────────────────────────

  async _step0_Reception(sprint) {
    const { id: sprintId, project, requirementText, requirementFile, number } = sprint;
    logger.info({ sprintId, step: 0 }, 'Step 0: Reception Report');
    await this._lock(sprintId, 0);

    try {
      let requirement = requirementText || '';
      if (requirementFile) {
        const { extractText } = await import('../fileService.js');
        const { extractedText } = await extractText(requirementFile);
        requirement += `\n\n[File content]:\n${extractedText}`;
      }

      if (!requirement.trim()) {
        throw new Error('No requirement text provided');
      }

      const builder = new PromptBuilder(project.repoPath);
      const projectContext = builder._getOptimizedContext(number);
      const prompt = builder.buildReceptionPrompt({ requirement, sprintNumber: number, projectContext });

      const result = await runClaudeWithRetry({ prompt, tools: [], cwd: project.repoPath, sprintId });
      if (!result.success) throw new Error(`Reception step failed: ${result.error}`);

      const parsed = parseClaudeOutput(result.output, 'reception');

      const notesForPO = formatReceptionForPO(parsed.success ? parsed.data : {}, result.output);

      await prisma.gate.update({
        where: { sprintId_gateNumber: { sprintId, gateNumber: 0 } },
        data: { notes: notesForPO },
      });

      const gate0Rec = await prisma.gate.findUnique({
        where: { sprintId_gateNumber: { sprintId, gateNumber: 0 } },
        select: { id: true },
      });

      const hasBlockers = parsed.success && parsed.data?.readyToProceed === false;

      await this.orch.notif.send({
        projectId: project.id,
        sprintId,
        type: 'gate_waiting',
        title: hasBlockers ? 'Reception Report — Co van de can lam ro' : 'Reception Report — Requirement du ro',
        message: `Sprint #${number}: ${hasBlockers ? `${parsed.data.blockers?.length || 0} blocker(s) can clarify` : 'Gate 0 cho duyet'}`,
        payload: { gateId: gate0Rec?.id },
      });

      await this._setGateWaiting(sprintId, 0, notesForPO);
      this.orch._emit('sprint:updated', { sprintId, currentGateNumber: 0 });

      logger.info({ sprintId, readyToProceed: parsed.data?.readyToProceed }, 'Step 0 completed');
    } catch (err) {
      await this._unlock(sprintId);
      throw err;
    }
  }

  // ─── STEP 1: ARCHITECT ─────────────────────────────────────────────────────

  async _step1_Architect(sprint) {
    const { id: sprintId, project, requirementText, requirementFile, number } = sprint;
    logger.info({ sprintId, step: 1 }, 'Step 1: Architect');
    await this._lock(sprintId, 1);

    try {
      let requirement = requirementText || '';
      if (requirementFile) {
        const { extractText } = await import('../fileService.js');
        const { extractedText } = await extractText(requirementFile);
        requirement += `\n\n[File content]:\n${extractedText}`;
      }

      // Load reception report from Gate 0 (if available)
      let receptionReport = null;
      try {
        const gate0 = await prisma.gate.findUnique({
          where: { sprintId_gateNumber: { sprintId, gateNumber: 0 } },
          select: { structuredData: true, notes: true },
        });
        if (gate0?.structuredData) {
          receptionReport = JSON.parse(gate0.structuredData);
        } else if (gate0?.notes) {
          receptionReport = extractJSONFromNotes(gate0.notes);
        }
      } catch (g0err) {
        logger.warn({ sprintId, err: g0err.message }, 'Could not load Gate 0 reception report — continuing without it');
      }

      const builder = new PromptBuilder(project.repoPath);
      const prompt = builder.buildArchitectPrompt({ requirement, sprintNumber: number, receptionReport });

      const result = await runClaudeWithRetry({ prompt, tools: [], cwd: project.repoPath, sprintId });
      if (!result.success) throw new Error(`Architect Claude call failed: ${result.error}`);

      const parsed = parseClaudeOutput(result.output, 'architect');
      if (!parsed.success) throw new Error(`Cannot parse architect output: ${parsed.error}`);

      // Write TCR structure for this sprint
      if (parsed.data?.tcrUpdate || parsed.data?.contextIndexUpdate) {
        try {
          const tcrDir = path.join(project.repoPath, 'docs', 'tcr', `sprint-${number}`);
          const tcrIndexDir = path.join(project.repoPath, 'docs', 'tcr');
          const contextDir = path.join(project.repoPath, 'docs', 'context');

          await fs.mkdir(tcrDir, { recursive: true });
          await fs.mkdir(contextDir, { recursive: true });

          // 1. Write TCR-sprint-N.md
          if (parsed.data.tcrUpdate) {
            const { summary, decisions = [], filesChanged = [], nextSprintContext } = parsed.data.tcrUpdate;
            const tcrContent = `# TCR — Sprint #${number}
Date: ${new Date().toISOString().split('T')[0]} | Status: In Progress

## Summary
${summary}

## Technical Decisions
${decisions.map((d) => `- ${d}`).join('\n') || '_None_'}

## Files Changed
${filesChanged.map((f) => `- ${f}`).join('\n') || '_See task specs_'}

## Next Sprint Context
${nextSprintContext || '_Update after sprint completes_'}
`;
            const tcrPath = path.join(tcrDir, `TCR-sprint-${number}.md`);
            await fs.writeFile(tcrPath, tcrContent, 'utf8');
            logger.info({ sprintId, tcrPath }, 'TCR created for sprint');
          }

          // 2. Update TCR _index.md
          const tcrIndexPath = path.join(tcrIndexDir, '_index.md');
          let tcrIndex = '';
          try { tcrIndex = await fs.readFile(tcrIndexPath, 'utf8'); } catch { tcrIndex = '# TCR Index\n\n'; }

          const newEntry = `- [Sprint #${number}](sprint-${number}/TCR-sprint-${number}.md) — ${new Date().toISOString().split('T')[0]}: ${(parsed.data.tcrUpdate?.summary || '').split('\n')[0].substring(0, 80)}\n`;
          if (!tcrIndex.includes(`Sprint #${number}`)) {
            tcrIndex += newEntry;
            await fs.writeFile(tcrIndexPath, tcrIndex, 'utf8');
          }

          // 3. Update context/index.md
          if (parsed.data.contextIndexUpdate) {
            const contextIndexPath = path.join(contextDir, 'index.md');
            let contextIndex = '';
            try { contextIndex = await fs.readFile(contextIndexPath, 'utf8'); } catch {
              contextIndex = `# Project Context Index\n> Load file nay dau tien moi phien lam viec.\n\n`;
            }

            const sprintBlock = `\n## Sprint #${number} (${new Date().toISOString().split('T')[0]})\n${parsed.data.contextIndexUpdate}\n`;
            if (!contextIndex.includes(`## Sprint #${number}`)) {
              contextIndex += sprintBlock;
              // Keep index short — only last 10 sprints
              const lines = contextIndex.split('\n');
              if (lines.length > 200) {
                const headerLines = lines.slice(0, 3);
                const recentLines = lines.slice(-150);
                contextIndex = [...headerLines, '_(older sprints truncated)_', ...recentLines].join('\n');
              }
              await fs.writeFile(contextIndexPath, contextIndex, 'utf8');
            }
          }

          logger.info({ sprintId, sprintNumber: number }, 'TCR structure updated');
        } catch (tcrErr) {
          logger.warn({ sprintId, error: tcrErr.message }, 'Failed to write TCR — continuing');
          try {
            await this.orch.notif.send({
              projectId: project.id,
              sprintId,
              type: 'warn',
              title: '⚠️ TCR write failed',
              message: `Sprint #${number}: Could not write Technical Context Record. Next sprint Architect will not have memory of this sprint. Check that docs/tcr/ directory exists.`,
              payload: { sprintId },
            });
          } catch (_) {}
        }
      }

      // Backward compatibility: still write MASTER.md if provided
      if (parsed.data?.masterMdUpdate) {
        const masterPath = path.join(project.repoPath, 'docs', 'MASTER.md');
        try {
          await fs.mkdir(path.join(project.repoPath, 'docs'), { recursive: true });
          await fs.writeFile(masterPath, parsed.data.masterMdUpdate, 'utf8');
          logger.info({ sprintId, masterPath }, 'MASTER.md updated (legacy)');
        } catch (writeErr) {
          logger.warn({ sprintId, error: writeErr.message }, 'Failed to write MASTER.md');
        }
      }

      // Write zone-classification.md if architect returned it
      if (parsed.data?.zoneClassification) {
        const zonePath = path.join(project.repoPath, 'docs', 'zone-classification.md');
        try {
          const { frozen = [], guarded = [], fluid = '' } = parsed.data.zoneClassification;
          const zoneContent = `# Zone Classification — Sprint #${number}
> Duoc tao boi Architect AI. Developer Agent phai doc file nay truoc khi code.

## FROZEN — KHONG duoc sua
${frozen.length === 0 ? '_Khong co file nao_' : frozen.map((z) => `- \`${z.path}\` — ${z.reason}`).join('\n')}

## GUARDED — Duoc sua nhung PHAI giai thich ly do
${guarded.length === 0 ? '_Khong co file nao_' : guarded.map((z) => `- \`${z.path}\` — ${z.reason}`).join('\n')}

## FLUID — Tu do implement
${fluid || 'Implementation details, UI components, utilities, tests'}
`;
          await fs.mkdir(path.join(project.repoPath, 'docs'), { recursive: true });
          await fs.writeFile(zonePath, zoneContent, 'utf8');
          logger.info({ sprintId, zonePath }, 'zone-classification.md updated');
        } catch (zoneErr) {
          logger.warn({ sprintId, error: zoneErr.message }, 'Failed to write zone-classification.md');
        }
      }

      const notesForPO = formatArchitectForPO(parsed.data);

      await prisma.gate.update({
        where: { sprintId_gateNumber: { sprintId, gateNumber: 1 } },
        data: { notes: notesForPO, structuredData: JSON.stringify(parsed.data) },
      });

      const gate1Rec = await prisma.gate.findUnique({
        where: { sprintId_gateNumber: { sprintId, gateNumber: 1 } },
        select: { id: true },
      });
      await this.orch.notif.send({
        projectId: project.id,
        sprintId,
        type: 'gate_waiting',
        title: 'Architecture designed',
        message: `Sprint #${number}: Gate 1 waiting for review`,
        payload: { gateId: gate1Rec.id },
      });

      await this._setGateWaiting(sprintId, 1, notesForPO);
      this.orch._emit('sprint:updated', { sprintId, currentGateNumber: 1 });

      logger.info({ sprintId }, 'Step 1 completed');
    } catch (err) {
      await this._unlock(sprintId);
      throw err;
    }
  }

  // ─── STEP 2: FEATURE SPECS ─────────────────────────────────────────────────

  async _step2_FeatureSpecs(sprint) {
    const { id: sprintId, project, number } = sprint;
    logger.info({ sprintId, step: 2 }, 'Step 2: Feature Specs');
    await this._lock(sprintId, 2);

    try {
      const gate1 = await prisma.gate.findUnique({
        where: { sprintId_gateNumber: { sprintId, gateNumber: 1 } },
      });

      const architectData = gate1.structuredData ? JSON.parse(gate1.structuredData) : extractJSONFromNotes(gate1.notes);
      if (!architectData) throw new Error('Cannot extract architect JSON from Gate 1 notes');

      const builder = new PromptBuilder(project.repoPath);
      const prompt = builder.buildFeatureSpecPrompt({ architectOutput: architectData, sprintNumber: number });

      const result = await runClaudeWithRetry({ prompt, tools: [], cwd: project.repoPath, sprintId });
      if (!result.success) throw new Error(`Feature specs step failed: ${result.error}`);

      const parsed = parseClaudeOutput(result.output, 'featureSpecs');
      if (!parsed.success) throw new Error(`Could not parse feature specs: ${parsed.error}`);

      const notesForPO = formatFeatureSpecsForPO(parsed.data);

      await prisma.gate.update({
        where: { sprintId_gateNumber: { sprintId, gateNumber: 2 } },
        data: { notes: notesForPO, structuredData: JSON.stringify(parsed.data) },
      });

      const gate2Rec = await prisma.gate.findUnique({
        where: { sprintId_gateNumber: { sprintId, gateNumber: 2 } },
        select: { id: true },
      });
      await this.orch.notif.send({
        projectId: project.id,
        sprintId,
        type: 'gate_waiting',
        title: 'Feature Specs completed',
        message: `Sprint #${number}: Gate 2 waiting for review`,
        payload: { gateId: gate2Rec.id },
      });

      await this._setGateWaiting(sprintId, 2, notesForPO);
      this.orch._emit('sprint:updated', { sprintId, currentGateNumber: 2 });

      logger.info({ sprintId }, 'Step 2 completed');
    } catch (err) {
      await this._unlock(sprintId);
      throw err;
    }
  }

  // ─── STEP 3: ATOMIC TASKS ──────────────────────────────────────────────────

  async _step3_AtomicTasks(sprint) {
    const { id: sprintId, project, number } = sprint;
    logger.info({ sprintId, step: 3 }, 'Step 3: Atomic Tasks');
    await this._lock(sprintId, 3);

    try {
      const gate2 = await prisma.gate.findUnique({
        where: { sprintId_gateNumber: { sprintId, gateNumber: 2 } },
      });

      const featureData = gate2.structuredData ? JSON.parse(gate2.structuredData) : extractJSONFromNotes(gate2.notes);
      if (!featureData) throw new Error('Cannot extract feature specs JSON from Gate 2 notes');

      const builder = new PromptBuilder(project.repoPath);
      const prompt = builder.buildAtomicTaskPrompt({ featureSpecs: featureData, sprintNumber: number });

      const result = await runClaudeWithRetry({ prompt, tools: [], cwd: project.repoPath, sprintId });
      if (!result.success) throw new Error(`Atomic tasks step failed: ${result.error}`);

      const parsed = parseClaudeOutput(result.output, 'atomicTasks');
      if (!parsed.success) throw new Error(`Could not parse atomic tasks: ${parsed.error}`);

      const { tasks, conflictWarnings } = parsed.data;

      // Handle edge case: 0 tasks generated
      if (!tasks || tasks.length === 0) {
        logger.warn({ sprintId }, 'AtomicTaskPlanner returned 0 tasks — stopping pipeline');
        const gate3Rec = await prisma.gate.findUnique({
          where: { sprintId_gateNumber: { sprintId, gateNumber: 3 } },
          select: { id: true },
        });
        await this.orch.notif.send({
          projectId: project.id,
          sprintId,
          type: 'gate_waiting',
          title: 'No tasks generated — needs review',
          message: `Sprint #${number}: AtomicTaskPlanner produced 0 tasks. The requirement may be too vague or the AI encountered an issue. Please review and re-run.`,
          payload: { gateId: gate3Rec?.id },
        });
        await this._setGateWaiting(sprintId, 3, `⚠️ AtomicTaskPlanner returned 0 tasks for Sprint #${number}. Possible causes:\n- Requirement too vague for task decomposition\n- AI output parsing issue\n\nPlease review the feature specs (Gate 2) and re-approve to retry.`);
        this.orch._emit('sprint:updated', { sprintId, currentGateNumber: 3 });
        return;
      }

      // Validate atomic constraints (warn only, don't block)
      for (const task of tasks) {
        const fileCount = (task.filesToCreate || []).length + (task.filesToModify || []).length;
        if (fileCount > 3) {
          logger.warn({ taskId: task.taskId, fileCount }, 'Task exceeds 3-file limit');
        }
      }

      // Upsert tasks into DB
      for (const task of tasks) {
        await prisma.task.upsert({
          where: { sprintId_taskId: { sprintId, taskId: task.taskId } },
          create: {
            sprintId,
            taskId: task.taskId,
            featureRef: task.featureRef || null,
            agentSlot: task.agentSlot || 1,
            title: task.title,
            description: task.description,
            spec: JSON.stringify(task),
            status: TASK_STATUS.PENDING,
          },
          update: {
            title: task.title,
            description: task.description,
            spec: JSON.stringify(task),
            status: TASK_STATUS.PENDING,
          },
        });
      }

      const notesForPO = formatTasksForPO(tasks, conflictWarnings);

      await prisma.gate.update({
        where: { sprintId_gateNumber: { sprintId, gateNumber: 3 } },
        data: { notes: notesForPO, structuredData: JSON.stringify(parsed.data) },
      });

      const gate3Rec = await prisma.gate.findUnique({
        where: { sprintId_gateNumber: { sprintId, gateNumber: 3 } },
        select: { id: true },
      });
      await this.orch.notif.send({
        projectId: project.id,
        sprintId,
        type: 'gate_waiting',
        title: `${tasks.length} Atomic Tasks ready`,
        message: `Sprint #${number}: Gate 3 waiting for approval to start coding`,
        payload: { gateId: gate3Rec.id },
      });

      await this._setGateWaiting(sprintId, 3, notesForPO);
      this.orch._emit('sprint:updated', { sprintId, currentGateNumber: 3 });

      logger.info({ sprintId, taskCount: tasks.length }, 'Step 3 completed');
    } catch (err) {
      await this._unlock(sprintId);
      throw err;
    }
  }

  // ─── STEP 4: DEVELOPER AGENTS — SEQUENTIAL ─────────────────────────────────

  async _step4_DeveloperAgents(sprint) {
    const { id: sprintId, project } = sprint;
    logger.info({ sprintId, step: 4 }, 'Step 4: Developer Agents');
    await this._lock(sprintId, 4);

    try {
      const config = await prisma.pipelineConfig.findUnique({ where: { id: 'singleton' } });
      const maxRetry = config?.maxRetryRounds || 3;

      const tasks = await prisma.task.findMany({
        where: { sprintId, status: TASK_STATUS.PENDING },
        orderBy: { taskId: 'asc' },
      });

      if (tasks.length === 0) {
        logger.warn({ sprintId }, 'No pending tasks found for Step 4');
        await this._unlock(sprintId);
        return;
      }

      const wtManager = new WorktreeManager(project.repoPath);
      const builder = new PromptBuilder(project.repoPath);

      // Pre-check conflicts to determine which tasks can run in parallel
      const parsedTasks = tasks.map((t) => ({ ...t, spec: JSON.parse(t.spec) }));
      const conflicts = await wtManager.checkConflicts(parsedTasks);
      const conflictingTaskIds = new Set();
      for (const c of conflicts) {
        conflictingTaskIds.add(c.task1);
        conflictingTaskIds.add(c.task2);
      }
      if (conflicts.length > 0) {
        logger.warn({ conflicts, conflictingTasks: [...conflictingTaskIds] }, 'File conflicts detected — conflicting tasks will run sequentially');
      }

      const maxParallel = config?.maxParallelAgents || 1;

      if (maxParallel <= 1) {
        // Sequential execution (safe default)
        for (const task of tasks) {
          await this._taskExecutor.executeTask(task, { wtManager, builder, sprint, maxRetry });
        }
      } else {
        // Parallel execution — split into safe parallel group + sequential conflict group
        const parallelTasks = tasks.filter(t => !conflictingTaskIds.has(t.taskId));
        const sequentialTasks = tasks.filter(t => conflictingTaskIds.has(t.taskId));

        logger.info({ parallel: parallelTasks.length, sequential: sequentialTasks.length, maxParallel }, 'Task execution plan');

        // Run parallel tasks in batches of maxParallel
        for (let i = 0; i < parallelTasks.length; i += maxParallel) {
          const batch = parallelTasks.slice(i, i + maxParallel);
          await Promise.all(
            batch.map(task => this._taskExecutor.executeTask(task, { wtManager, builder, sprint, maxRetry }))
          );
        }

        // Run conflicting tasks sequentially (they touch the same files)
        for (const task of sequentialTasks) {
          await this._taskExecutor.executeTask(task, { wtManager, builder, sprint, maxRetry });
        }
      }

      // Check for escalated tasks
      const escalated = await prisma.task.findMany({
        where: { sprintId, status: TASK_STATUS.ESCALATED },
      });

      if (escalated.length > 0) {
        await prisma.sprint.update({
          where: { id: sprintId },
          data: { status: SPRINT_STATUS.WAITING_HUMAN, isProcessing: false },
        });
        await this.orch.notif.send({
          projectId: project.id,
          sprintId,
          type: 'task_escalated',
          title: `${escalated.length} task(s) need manual intervention`,
          message: 'Go to Dashboard → Tasks to review and Override',
        });
        this.orch._emit('sprint:updated', { sprintId, status: SPRINT_STATUS.WAITING_HUMAN });
        return;
      }

      // All PASS → Gate 4 auto-advance
      await prisma.gate.update({
        where: { sprintId_gateNumber: { sprintId, gateNumber: 4 } },
        data: { status: GATE_STATUS.APPROVED, approvedAt: new Date(), approvedBy: 'auto' },
      });

      this.orch._emit('gate:updated', {
        sprintId, gateNumber: 4, status: GATE_STATUS.APPROVED,
      });

      logger.info({ sprintId }, 'All tasks PASS — Gate 4 auto-approved, running integration verify');

      // Run integration verification before QA
      const freshSprint = await this._reloadSprint(sprintId);
      await this._step4b_IntegrationVerify(freshSprint);
    } catch (err) {
      await this._unlock(sprintId);
      throw err;
    }
  }

  // ─── DEPLOY (delegated to DeployRunner) ─────────────────────────────────────

  async runLocalSetup(project) { return this._deploy.runLocalSetup(project); }
  async runUATDeploy(project, config) { return this._deploy.runUATDeploy(project, config); }

  // ─── INTEGRATION VERIFY (delegated to IntegrationVerifier) ───────────────

  async _step4b_IntegrationVerify(sprint) {
    await this._integrationVerifier.verify(sprint);
    const freshSprint = await this._reloadSprint(sprint.id);
    await this._qaRunner.step5_QA(freshSprint);
  }

  // ─── TASK EXECUTION (delegated to TaskExecutor) ─────────────────────────────

  // ���── QA (delegated to QARunner) ─────────────────────────────────────────────
  async runQAFix(sprint, qaNotes, opts) { return this._qaRunner.runQAFix(sprint, qaNotes, opts); }

  // ─── SPRINT PLANNING: Split large requirements ─────────────────────────────

  async planSprints(project, requirement) {
    logger.info({ projectId: project.id }, 'Sprint Planner running');

    // Mark project as planning — survives page reload
    await prisma.project.update({ where: { id: project.id }, data: { status: 'planning' } });

    // Save full original requirement to docs for all sprints to reference
    try {
      const reqPath = path.join(project.repoPath, 'docs', 'FULL_REQUIREMENT.md');
      await fs.mkdir(path.join(project.repoPath, 'docs'), { recursive: true });
      await fs.writeFile(reqPath, `# Full Project Requirement\n\n${requirement}`, 'utf8');
      logger.info({ projectId: project.id }, 'Full requirement saved to docs/FULL_REQUIREMENT.md');
    } catch {}

    this.orch._emit('qa:fix_progress', { sprintId: null, phase: 'planning', message: 'Sprint Planner dang phan tich requirement...' });

    const builder = new PromptBuilder(project.repoPath);
    const projectContext = builder._getOptimizedContext(1);

    const prompt = builder.buildSprintPlanPrompt({ requirement, projectContext, receptionReport: null });

    this.orch._emit('qa:fix_progress', { sprintId: null, phase: 'planning', message: 'Claude đang phân tích requirement và chia sprints...' });

    const result = await runClaudeWithRetry({ prompt, tools: [], cwd: project.repoPath });

    if (!result.success) throw new Error('Sprint Planner failed: ' + result.error);

    this.orch._emit('qa:fix_progress', { sprintId: null, phase: 'parsing', message: 'Đã nhận kết quả, đang xử lý...' });

    const parsed = parseClaudeOutput(result.output, 'sprintPlan');
    if (!parsed.success) throw new Error('Cannot parse sprint plan: ' + parsed.error);

    const plan = parsed.data;
    logger.info({ projectId: project.id, totalSprints: plan.totalSprints }, 'Sprint plan created');

    // ── COVERAGE CHECK: verify all requirements are covered ───────────────
    this.orch._emit('qa:fix_progress', { sprintId: null, phase: 'verifying', message: 'Dang kiem tra do phu cua sprint plan...' });

    let coverageResult = null;
    try {
      const coveragePrompt = builder.buildSprintCoverageCheckPrompt({
        fullRequirement: requirement,
        sprintPlan: plan.sprints.map((s) => ({ sprint: s.sprintNumber, name: s.name, features: s.features, scope: s.scope })),
      });

      const coverageRes = await runClaudeWithRetry({ prompt: coveragePrompt, tools: [], cwd: project.repoPath });

      if (coverageRes.success) {
        const coverageParsed = parseClaudeOutput(coverageRes.output, 'sprintCoverageCheck');
        coverageResult = coverageParsed.data;

        if (coverageResult?.missingFeatures?.length > 0) {
          logger.warn({ missing: coverageResult.missingFeatures.length }, 'Coverage check found missing features');
        }
        logger.info({
          coverage: coverageResult?.coveragePercent,
          missing: coverageResult?.missingCount,
          verdict: coverageResult?.verdict,
        }, 'Coverage check completed');

        if (coverageParsed?.data?.verdict === 'MISSING_CRITICAL') {
          const missing = coverageParsed.data.missingFeatures || [];
          logger.warn({ sprintCount: plan.totalSprints, missingCount: missing.length }, 'Sprint plan has missing critical features');
          try {
            await this.orch.notif.send({
              projectId: project.id,
              type: 'warn',
              title: '⚠️ Sprint plan missing critical features',
              message: `Coverage check found ${missing.length} missing feature(s):\n${missing.map(f => `• ${f.requirement} (suggested: Sprint ${f.suggestedSprint || '?'})`).join('\n')}\n\nSprints have been created. Review and adjust before approving Gate 0.`,
              payload: { missingFeatures: missing },
            });
          } catch (_) {}
        } else if (coverageParsed?.data?.coveragePercent < 100) {
          logger.info({ coveragePercent: coverageParsed.data.coveragePercent }, 'Sprint plan coverage is not 100% but no critical missing features');
        }
      }
    } catch (covErr) {
      logger.warn({ err: covErr.message }, 'Coverage check failed — continuing without');
    }

    // Format for PO notification
    let planNotes = `## Sprint Plan — ${plan.totalSprints} sprints\n`;
    planNotes += `*Uoc tinh: ${plan.estimatedWeeks || '?'} tuan*\n\n`;

    // Add coverage result
    if (coverageResult) {
      planNotes += `### Do phu yeu cau: ${coverageResult.coveragePercent || '?'}%\n`;
      planNotes += `**Verdict:** ${coverageResult.verdict || 'N/A'}\n`;
      if (coverageResult.missingFeatures?.length > 0) {
        planNotes += `\n**Tinh nang bi thieu (${coverageResult.missingFeatures.length}):**\n`;
        for (const m of coverageResult.missingFeatures) {
          planNotes += `- ${m.requirement} _(nen them vao ${m.suggestedSprint || 'sprint moi'})_\n`;
        }
      }
      if (coverageResult.vagueFeatures?.length > 0) {
        planNotes += `\n**Tinh nang chua ro (${coverageResult.vagueFeatures.length}):**\n`;
        for (const v of coverageResult.vagueFeatures) {
          planNotes += `- ${v.requirement}: ${v.issue}\n`;
        }
      }
      planNotes += '\n';
    }
    for (const s of plan.sprints) {
      planNotes += `### Sprint ${s.sprintNumber}: ${s.name}\n`;
      planNotes += `${s.scope}\n`;
      planNotes += `**Features:** ${s.features.join(', ')}\n`;
      planNotes += `**Deliverable:** ${s.deliverable}\n\n`;
    }

    await this.orch.notif.send({
      projectId: project.id,
      type: 'gate_waiting',
      title: `Sprint Plan: ${plan.totalSprints} sprints`,
      message: planNotes.substring(0, 500),
      payload: { plan, projectId: project.id },
    });

    // Auto-create sprints in DB
    this.orch._emit('qa:fix_progress', { sprintId: null, phase: 'creating', message: `Đang tạo ${plan.totalSprints} sprints...` });
    const { GATE_DEFINITIONS } = await import('../../lib/constants.js');

    for (const s of plan.sprints) {
      const last = await prisma.sprint.findFirst({
        where: { projectId: project.id },
        orderBy: { number: 'desc' },
      });
      const nextNumber = last ? last.number + 1 : 1;

      const sprint = await prisma.sprint.create({
        data: {
          projectId: project.id,
          number: nextNumber,
          name: s.name,
          requirementText: [
            `## Sprint ${s.sprintNumber}: ${s.name}`,
            `\n### Scope\n${s.scope}`,
            `\n### Features\n${s.features.map((f) => `- ${f}`).join('\n')}`,
            `\n### Deliverable\n${s.deliverable}`,
            s.detailedRequirement ? `\n### Chi tiet yeu cau (trich xuat tu tai lieu goc)\n${s.detailedRequirement}` : '',
            `\n### Dependencies\n${s.dependencies?.length ? s.dependencies.join(', ') : 'Khong co'}`,
          ].filter(Boolean).join('\n'),
        },
      });

      const gateData = Object.entries(GATE_DEFINITIONS).map(([num, def]) => ({
        sprintId: sprint.id,
        gateNumber: parseInt(num),
        title: def.title,
        description: def.title,
        status: 'pending',
      }));
      await prisma.gate.createMany({ data: gateData });

      logger.info({ sprintNumber: nextNumber, name: s.name }, 'Sprint created from plan');
    }

    await this.orch.notif.send({
      projectId: project.id,
      type: 'sprint_complete',
      title: `${plan.totalSprints} sprints da tao`,
      message: 'Vao project detail de bat dau sprint 1.',
    });

    await prisma.project.update({ where: { id: project.id }, data: { status: 'active' } });
    this.orch._emit('qa:fix_progress', { sprintId: null, phase: 'done', message: `${plan.totalSprints} sprints da tao` });

    return plan;
  }

  // ─── BUGFIX (delegated to BugfixRunner) ──────────────────────────────────
  async runBugfix(project, errorDescription) { return this._bugfix.runBugfix(project, errorDescription); }

  // ─── SINGLE TASK RETRY (delegated to TaskExecutor) ──────────────────────────
  async retryTask(taskId, sprint) { return this._taskExecutor.retryTask(taskId, sprint); }
}
