import prisma from '../../lib/prisma.js';
import logger from '../../lib/logger.js';
import { GATE_TO_STEP, StateMachine } from './stateMachine.js';
import { GATE_STATUS, SPRINT_STATUS, TASK_STATUS } from '../../lib/constants.js';
import { PipelineRunner } from './pipelineRunner.js';
import { NotificationService } from '../notificationService.js';

export class Orchestrator {
  constructor(io, bot) {
    this.io = io;
    this.bot = bot;
    this.notif = new NotificationService(io, bot);
    this.runner = new PipelineRunner(this);
    this.sm = new StateMachine();
  }

  /**
   * ENTRY POINT — PO approves a gate.
   * Validate → Update DB → Trigger next step (async, non-blocking).
   */
  async onGateApproved(gateId, { comment = null, approvedBy = 'web' } = {}) {
    const gate = await prisma.gate.findUnique({
      where: { id: gateId },
      include: { sprint: { include: { project: true } } },
    });

    if (!gate) throw new Error(`Gate ${gateId} not found`);
    if (gate.status !== GATE_STATUS.WAITING_APPROVAL) {
      logger.warn({ gateId, status: gate.status }, 'Gate already processed — ignoring duplicate approval');
      return;
    }

    const { sprint } = gate;

    if (sprint.isProcessing) {
      throw new Error('Pipeline is currently processing, please wait');
    }

    // Atomic transaction: update gate + set lock together to prevent race condition
    await prisma.$transaction([
      prisma.gate.update({
        where: { id: gateId },
        data: {
          status: GATE_STATUS.APPROVED,
          poComment: comment,
          approvedAt: new Date(),
          approvedBy,
        },
      }),
      prisma.sprint.update({
        where: { id: sprint.id },
        data: { isProcessing: true },
      }),
    ]);

    this._emit('gate:updated', {
      gateId,
      sprintId: sprint.id,
      gateNumber: gate.gateNumber,
      status: GATE_STATUS.APPROVED,
    });

    logger.info({ gateId, gateNumber: gate.gateNumber, sprintId: sprint.id }, 'Gate approved');

    // Trigger next step async — don't await so response returns immediately
    setImmediate(() => this._triggerNextStep(sprint, gate.gateNumber));
  }

  /**
   * PO rejects a gate.
   */
  async onGateRejected(gateId, { reason = '', rejectedBy = 'web' } = {}) {
    const gate = await prisma.gate.findUnique({
      where: { id: gateId },
      include: { sprint: true },
    });

    if (!gate) throw new Error('Gate not found');
    if (gate.status !== GATE_STATUS.WAITING_APPROVAL) {
      throw new Error(`Cannot reject gate in status: ${gate.status}`);
    }

    await prisma.gate.update({
      where: { id: gateId },
      data: { status: GATE_STATUS.REJECTED, poComment: reason },
    });

    // Reset sprint to waiting_gate so PO can re-trigger
    await prisma.sprint.update({
      where: { id: gate.sprintId },
      data: { status: SPRINT_STATUS.WAITING_GATE, isProcessing: false },
    });

    await this.notif.send({
      projectId: gate.sprint.projectId,
      sprintId: gate.sprintId,
      type: 'gate_rejected',
      title: `Gate ${gate.gateNumber} rejected`,
      message: reason || 'PO rejected this gate',
    });

    this._emit('gate:updated', {
      gateId,
      sprintId: gate.sprintId,
      gateNumber: gate.gateNumber,
      status: GATE_STATUS.REJECTED,
    });

    logger.info({ gateId, gateNumber: gate.gateNumber, reason }, 'Gate rejected');
  }

  /**
   * Trigger the step corresponding to the approved gate.
   * Catches errors and marks sprint as failed.
   */
  async _triggerNextStep(sprint, gateNumber) {
    const nextAction = GATE_TO_STEP[gateNumber];
    if (nextAction === undefined || nextAction === null) return;

    logger.info(
      { sprintId: sprint.id, gateNumber, nextAction },
      '_triggerNextStep called'
    );

    try {
      if (nextAction === 'gate6') {
        await this._showGate6(sprint);
      } else if (nextAction === 'merge') {
        await this.runner.runMerge(sprint);
      } else {
        // nextAction is a step number (1-5)
        await this.runner.runStep(sprint, nextAction);
      }
    } catch (err) {
      logger.error({ err, sprintId: sprint.id, gateNumber }, 'Step execution failed');

      // Pause sprint and ask PO what to do
      await this._askPOOnError(sprint, gateNumber, err.message);
    }
  }

  /**
   * When any step fails, ask PO via Telegram + Dashboard what to do:
   * - Retry: re-run the failed step
   * - Skip: move to next gate/step
   * - Stop: mark sprint as failed
   */
  async _askPOOnError(sprint, gateNumber, errorMsg) {
    await prisma.sprint.update({
      where: { id: sprint.id },
      data: { status: 'waiting_human', isProcessing: false },
    });

    // Store error context for later action
    const errorPayload = { sprintId: sprint.id, gateNumber, error: errorMsg };

    await this.notif.send({
      projectId: sprint.projectId,
      sprintId: sprint.id,
      type: 'pipeline_error',
      title: 'Pipeline gặp lỗi',
      message: errorMsg.substring(0, 300),
      payload: errorPayload,
    });

    this._emit('sprint:error', { sprintId: sprint.id, error: errorMsg, gateNumber, actions: ['retry', 'skip', 'stop'] });
    this._emit('sprint:updated', { sprintId: sprint.id, status: 'waiting_human' });
  }

  /**
   * PO responds to a pipeline error.
   * action: 'retry' | 'skip' | 'stop'
   */
  async handleErrorAction(sprintId, action) {
    const sprint = await prisma.sprint.findUnique({
      where: { id: sprintId },
      include: { project: true, gates: { orderBy: { gateNumber: 'asc' } } },
    });

    if (!sprint) throw new Error('Sprint not found');

    logger.info({ sprintId, action }, 'PO error action');

    if (action === 'stop') {
      await prisma.sprint.update({
        where: { id: sprintId },
        data: { status: SPRINT_STATUS.FAILED, isProcessing: false },
      });
      await this.notif.send({
        projectId: sprint.projectId, sprintId,
        type: 'sprint_failed',
        title: 'Sprint dừng bởi PO',
        message: 'PO quyết định dừng pipeline.',
      });
      this._emit('sprint:updated', { sprintId, status: SPRINT_STATUS.FAILED });
      return { ok: true, action: 'stopped' };
    }

    if (action === 'skip') {
      // Find the last approved gate and advance to next
      const lastApproved = [...sprint.gates].reverse().find((g) => g.status === GATE_STATUS.APPROVED);
      const nextGateNum = (lastApproved?.gateNumber ?? -1) + 1;
      const nextGate = sprint.gates.find((g) => g.gateNumber === nextGateNum);

      if (nextGate && nextGateNum <= 6) {
        // Mark current step's gate as auto-approved (skipped)
        await prisma.gate.update({
          where: { id: nextGate.id },
          data: { status: GATE_STATUS.APPROVED, approvedBy: 'skip', approvedAt: new Date(), poComment: 'Bỏ qua lỗi — PO approved' },
        });
        await prisma.sprint.update({
          where: { id: sprintId },
          data: { isProcessing: true, status: SPRINT_STATUS.RUNNING_STEP },
        });
        this._emit('gate:updated', { sprintId, gateNumber: nextGateNum, status: GATE_STATUS.APPROVED });

        // Trigger the step after the skipped gate
        setImmediate(() => this._triggerNextStep(sprint, nextGateNum));
        return { ok: true, action: 'skipped', nextGate: nextGateNum };
      }

      // No next gate — just complete
      await prisma.sprint.update({ where: { id: sprintId }, data: { status: SPRINT_STATUS.COMPLETED, isProcessing: false } });
      return { ok: true, action: 'completed' };
    }

    if (action === 'retry') {
      // Find the gate that was just approved before the error
      const lastApproved = [...sprint.gates].reverse().find((g) => g.status === GATE_STATUS.APPROVED);
      if (!lastApproved) throw new Error('No approved gate found to retry from');

      // Reset escalated tasks to pending so Step 4 picks them up
      const resetResult = await prisma.task.updateMany({
        where: { sprintId, status: TASK_STATUS.ESCALATED },
        data: { status: TASK_STATUS.PENDING, currentRound: 0, escalationReason: null },
      });
      if (resetResult.count > 0) {
        logger.info({ sprintId, resetCount: resetResult.count }, 'Reset escalated tasks to pending for retry');
      }

      await prisma.sprint.update({
        where: { id: sprintId },
        data: { isProcessing: true, status: SPRINT_STATUS.RUNNING_STEP },
      });

      setImmediate(() => this._triggerNextStep(sprint, lastApproved.gateNumber));
      return { ok: true, action: 'retrying', fromGate: lastApproved.gateNumber, tasksReset: resetResult.count };
    }

    throw new Error(`Unknown action: ${action}`);
  }

  /**
   * Show Gate 6 (final merge approval) to PO.
   */
  async _showGate6(sprint) {
    await prisma.gate.update({
      where: { sprintId_gateNumber: { sprintId: sprint.id, gateNumber: 6 } },
      data: { status: GATE_STATUS.WAITING_APPROVAL },
    });

    await prisma.sprint.update({
      where: { id: sprint.id },
      data: {
        status: SPRINT_STATUS.WAITING_GATE,
        currentGateNumber: 6,
        isProcessing: false,
      },
    });

    await this.notif.send({
      projectId: sprint.projectId,
      sprintId: sprint.id,
      type: 'gate_waiting',
      title: 'Ready to merge — Gate 6',
      message: 'QA approved. Approve Gate 6 to merge into main.',
    });

    this._emit('sprint:updated', { sprintId: sprint.id, currentGateNumber: 6 });
  }

  /**
   * Re-execute a single task that was reset to pending.
   */
  async retrySingleTask(taskId, sprint) {
    const fullSprint = await prisma.sprint.findUnique({
      where: { id: sprint.id },
      include: { project: true },
    });

    if (fullSprint.isProcessing) {
      throw new Error('Sprint is already processing');
    }

    logger.info({ taskId, sprintId: sprint.id }, 'Retrying single task');

    await prisma.sprint.update({
      where: { id: sprint.id },
      data: { isProcessing: true, status: SPRINT_STATUS.RUNNING_STEP },
    });

    setImmediate(() => this.runner.retryTask(taskId, fullSprint));
  }

  /**
   * Run QA-recommended fixes.
   * Parses issues from Gate 5 QA notes, creates fix tasks, runs them.
   */
  async runQAFix(sprintId, { fixAll = false } = {}) {
    const sprint = await prisma.sprint.findUnique({
      where: { id: sprintId },
      include: { project: true, gates: { orderBy: { gateNumber: 'asc' } } },
    });
    if (!sprint) throw new Error('Sprint not found');
    if (sprint.isProcessing) throw new Error('Sprint is already processing');

    const gate5 = sprint.gates.find((g) => g.gateNumber === 5);
    if (!gate5?.notes) throw new Error('No QA report found in Gate 5');

    // Prefer structured QA data for precise issue targeting, fallback to markdown notes
    let qaData = gate5.notes;
    if (gate5.structuredData) {
      try {
        qaData = JSON.parse(gate5.structuredData);
      } catch {
        qaData = gate5.notes;
      }
    }

    logger.info({ sprintId, fixAll, structured: typeof qaData === 'object' }, 'Running QA fix');

    await prisma.sprint.update({
      where: { id: sprintId },
      data: { isProcessing: true, status: SPRINT_STATUS.RUNNING_STEP, currentStep: 5 },
    });

    setImmediate(() => this.runner.runQAFix(sprint, qaData, { fixAll }));

    return { ok: true, message: 'QA fix started' };
  }

  /**
   * Pause a sprint — kill active subprocess and release lock.
   */
  async pauseSprint(sprintId) {
    this.runner.killActiveProcess(sprintId);
    await prisma.sprint.update({
      where: { id: sprintId },
      data: { isProcessing: false },
    });
    logger.info({ sprintId }, 'Sprint paused — subprocess killed');
  }

  /**
   * Resume pipeline after PO overrides escalated tasks.
   * If no escalated tasks remain → auto-advance Gate 4 → Step 5.
   */
  async resumeAfterHumanOverride(sprintId) {
    const escalated = await prisma.task.findMany({
      where: { sprintId, status: TASK_STATUS.ESCALATED },
    });

    if (escalated.length > 0) {
      logger.info({ sprintId, remaining: escalated.length }, 'Still has escalated tasks');
      return { resumed: false, remaining: escalated.length };
    }

    // All tasks resolved — auto-advance Gate 4
    await prisma.gate.update({
      where: { sprintId_gateNumber: { sprintId, gateNumber: 4 } },
      data: { status: GATE_STATUS.APPROVED, approvedAt: new Date(), approvedBy: 'auto' },
    });

    this._emit('gate:updated', { sprintId, gateNumber: 4, status: GATE_STATUS.APPROVED });

    logger.info({ sprintId }, 'All tasks resolved — Gate 4 auto-approved, triggering Step 5');

    const sprint = await prisma.sprint.findUnique({
      where: { id: sprintId },
      include: { project: true },
    });

    // Trigger Step 5 async
    setImmediate(() => this._triggerNextStep(sprint, 4));
    return { resumed: true, remaining: 0 };
  }

  /**
   * Resume a sprint from where it stopped.
   * Analyzes current state (gates, tasks) to determine what to re-run.
   */
  async resumeSprint(sprintId) {
    const sprint = await prisma.sprint.findUnique({
      where: { id: sprintId },
      include: { project: true, gates: { orderBy: { gateNumber: 'asc' } }, tasks: true },
    });

    if (!sprint) throw new Error('Sprint not found');
    if (sprint.isProcessing) throw new Error('Sprint is already processing');
    if (sprint.status === 'completed') throw new Error('Sprint already completed');

    // If sprint is pending (never started) → trigger Step 0 Reception
    if (sprint.status === 'pending') {
      logger.info({ sprintId }, 'Starting pending sprint — triggering Step 0');
      await prisma.sprint.update({
        where: { id: sprintId },
        data: { status: 'running_step', currentStep: 0 },
      });
      setImmediate(async () => {
        try {
          await this.runner._step0_Reception(sprint);
        } catch (err) {
          logger.error({ err: err.message, sprintId }, 'Step 0 failed on sprint start');
          await prisma.sprint.update({ where: { id: sprintId }, data: { status: 'waiting_gate', isProcessing: false } });
          await prisma.gate.update({
            where: { sprintId_gateNumber: { sprintId, gateNumber: 0 } },
            data: { status: 'waiting_approval', notes: `Reception failed: ${err.message}` },
          });
        }
      });
      return { action: 'started', message: 'Sprint bat dau — Reception dang chay' };
    }

    // Find the last approved gate
    const lastApproved = [...sprint.gates]
      .reverse()
      .find((g) => g.status === GATE_STATUS.APPROVED);

    // Find the first gate that's still waiting or pending after lastApproved
    const nextWaiting = sprint.gates.find(
      (g) => g.gateNumber > (lastApproved?.gateNumber ?? -1) && g.status === 'waiting_approval'
    );

    // If there's a gate waiting_approval → sprint is paused at a gate, nothing to resume
    if (nextWaiting) {
      return {
        action: 'waiting_gate',
        gateNumber: nextWaiting.gateNumber,
        message: `Sprint is waiting for Gate ${nextWaiting.gateNumber} approval. Approve it to continue.`,
      };
    }

    // Determine which step to re-run based on last approved gate
    const lastGateNum = lastApproved?.gateNumber ?? -1;
    const nextAction = GATE_TO_STEP[lastGateNum];

    if (nextAction === undefined || nextAction === null) {
      return { action: 'nothing', message: 'No resumable step found' };
    }

    // Special: if Step 4 was in progress, check task states
    if (lastGateNum === 3) {
      const hasPending = sprint.tasks.some((t) => t.status === 'pending');
      const hasEscalated = sprint.tasks.some((t) => t.status === 'escalated');
      const allPass = sprint.tasks.length > 0 && sprint.tasks.every((t) => t.status === 'pass');

      if (hasPending) {
        const pendingList = sprint.tasks.filter((t) => t.status === 'pending');
        const passList = sprint.tasks.filter((t) => t.status === 'pass');
        logger.info({
          sprintId, resumeFrom: sprint.status,
          pending: pendingList.length, pass: passList.length,
          escalated: sprint.tasks.filter((t) => t.status === 'escalated').length,
          pendingTaskIds: pendingList.map((t) => t.taskId),
        }, '[RESUME] Resuming sprint mid-execution — re-running pending tasks only');
      }

      if (allPass) {
        // All tasks done — resume from Gate 4 auto → Step 5
        logger.info({ sprintId }, 'Resume: all tasks pass, triggering Step 5');
        await prisma.sprint.update({ where: { id: sprintId }, data: { isProcessing: true, status: SPRINT_STATUS.RUNNING_STEP } });
        setImmediate(() => this._triggerNextStep(sprint, 4));
        return { action: 'resumed', step: 5, message: 'All tasks passed. Resuming QA review.' };
      }

      if (hasEscalated && !hasPending) {
        await prisma.sprint.update({ where: { id: sprintId }, data: { status: SPRINT_STATUS.WAITING_HUMAN } });
        return { action: 'waiting_human', message: `${sprint.tasks.filter((t) => t.status === 'escalated').length} task(s) escalated. Override or retry them.` };
      }
    }

    // Re-run the step that follows the last approved gate
    logger.info({ sprintId, lastGateNum, nextAction }, 'Resuming sprint');
    await prisma.sprint.update({
      where: { id: sprintId },
      data: { isProcessing: true, status: SPRINT_STATUS.RUNNING_STEP },
    });

    setImmediate(() => this._triggerNextStep(sprint, lastGateNum));

    const stepLabel = nextAction === 'gate6' ? 'Gate 6 display'
      : nextAction === 'merge' ? 'Merge'
      : `Step ${nextAction}`;

    return { action: 'resumed', step: nextAction, message: `Resuming from ${stepLabel}` };
  }

  /**
   * Emit socket event.
   */
  _emit(event, data) {
    this.io?.emit(event, data);
  }

  /**
   * Fetch full sprint state and emit to all connected clients.
   */
  async emitFullState(sprintId) {
    const sprint = await prisma.sprint.findUnique({
      where: { id: sprintId },
      include: {
        gates: { orderBy: { gateNumber: 'asc' } },
        tasks: { orderBy: { taskId: 'asc' } },
      },
    });
    if (sprint) this._emit('sprint:updated', sprint);
  }
}
