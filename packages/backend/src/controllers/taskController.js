import prisma from '../lib/prisma.js';

// GET /api/sprints/:sprintId/tasks
export async function listTasks(req, res) {
  const tasks = await prisma.task.findMany({
    where: { sprintId: req.params.sprintId },
    orderBy: { taskId: 'asc' },
    include: { _count: { select: { logs: true } } },
  });
  res.json(tasks);
}

// GET /api/tasks/:id
export async function getTask(req, res) {
  const task = await prisma.task.findUnique({
    where: { id: req.params.id },
    include: {
      sprint: { include: { project: true } },
      logs: { orderBy: { createdAt: 'desc' }, take: 10 },
    },
  });
  if (!task) return res.status(404).json({ error: 'Task not found' });
  res.json(task);
}

// GET /api/tasks/:id/logs
export async function getTaskLogs(req, res) {
  const task = await prisma.task.findUnique({ where: { id: req.params.id } });
  if (!task) return res.status(404).json({ error: 'Task not found' });

  const logs = await prisma.agentLog.findMany({
    where: { taskId: req.params.id },
    orderBy: { createdAt: 'asc' },
  });
  res.json(logs);
}

// POST /api/tasks/:id/override-pass — calls orchestrator.resumeAfterHumanOverride
export async function overridePass(req, res) {
  const task = await prisma.task.findUnique({ where: { id: req.params.id } });
  if (!task) return res.status(404).json({ error: 'Task not found' });

  if (task.status !== 'fail' && task.status !== 'escalated') {
    return res.status(400).json({
      error: `Can only override tasks with status fail or escalated (current: ${task.status})`,
    });
  }

  await prisma.task.update({
    where: { id: req.params.id },
    data: {
      status: 'pass',
      archVerdict: 'PASS',
      reviewParsed: JSON.stringify({ verdict: 'PASS', humanOverride: true }),
      completedAt: new Date(),
    },
  });

  // Try to resume pipeline if sprint was waiting_human
  const orchestrator = req.app.get('orchestrator');
  let resumeResult = null;
  try {
    resumeResult = await orchestrator.resumeAfterHumanOverride(task.sprintId);
  } catch (err) {
    // Don't fail the override if resume throws
  }

  res.json({
    message: 'Task overridden as PASS',
    resumed: resumeResult?.resumed || false,
    remainingEscalated: resumeResult?.remaining ?? null,
  });
}

// POST /api/tasks/:id/retry — reset task and re-execute
export async function retryTask(req, res) {
  const task = await prisma.task.findUnique({
    where: { id: req.params.id },
    include: { sprint: { include: { project: true } } },
  });
  if (!task) return res.status(404).json({ error: 'Task not found' });

  if (task.status !== 'fail' && task.status !== 'escalated') {
    return res.status(400).json({
      error: `Can only retry tasks with status fail or escalated (current: ${task.status})`,
    });
  }

  if (task.sprint.isProcessing) {
    return res.status(409).json({
      error: 'Sprint is currently processing. Wait for current step to complete before retrying.',
    });
  }

  await prisma.task.update({
    where: { id: req.params.id },
    data: {
      status: 'pending',
      currentRound: 0,
      devOutputRaw: null,
      devOutputParsed: null,
      validationResult: null,
      reviewOutputRaw: null,
      reviewParsed: null,
      archVerdict: null,
      escalationReason: null,
      completedAt: null,
    },
  });

  const orchestrator = req.app.get('orchestrator');
  try {
    await orchestrator.retrySingleTask(task.id, task.sprint);
    res.json({ message: 'Task reset and re-execution started', taskId: task.taskId });
  } catch (err) {
    res.json({
      message: 'Task reset to pending. Re-execution could not be triggered automatically.',
      taskId: task.taskId,
      warning: err.message,
    });
  }
}
