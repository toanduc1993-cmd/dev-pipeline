import prisma from '../lib/prisma.js';

// POST /api/pipeline/pause
export async function pausePipeline(req, res) {
  const orchestrator = req.app.get('orchestrator');
  const runningSprints = await prisma.sprint.findMany({
    where: { isProcessing: true },
    select: { id: true },
  });

  for (const sprint of runningSprints) {
    await orchestrator.pauseSprint(sprint.id);
  }

  res.json({
    ok: true,
    message: `Paused ${runningSprints.length} sprint(s)`,
    pausedCount: runningSprints.length,
  });
}

// POST /api/pipeline/resume — resume from last checkpoint
export async function resumePipeline(req, res) {
  const orchestrator = req.app.get('orchestrator');
  const { sprintId } = req.body || {};

  if (!sprintId) {
    // Auto-find: resume the most recent non-completed sprint
    const sprint = await prisma.sprint.findFirst({
      where: { status: { notIn: ['completed', 'failed', 'pending'] }, isProcessing: false },
      orderBy: { updatedAt: 'desc' },
    });

    if (!sprint) {
      return res.json({ ok: false, message: 'Không tìm thấy sprint nào cần resume' });
    }

    try {
      const result = await orchestrator.resumeSprint(sprint.id);
      return res.json({ ok: true, sprintId: sprint.id, ...result });
    } catch (err) {
      return res.status(400).json({ ok: false, error: err.message });
    }
  }

  try {
    const result = await orchestrator.resumeSprint(sprintId);
    res.json({ ok: true, sprintId, ...result });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
}

// POST /api/sprints/:id/resume — resume specific sprint
export async function resumeSprint(req, res) {
  const orchestrator = req.app.get('orchestrator');
  try {
    const result = await orchestrator.resumeSprint(req.params.id);
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
}

// POST /api/pipeline/error-action — PO responds to pipeline error
export async function handleErrorAction(req, res) {
  const orchestrator = req.app.get('orchestrator');
  const { sprintId, action } = req.body || {};

  if (!sprintId || !action) {
    return res.status(400).json({ error: 'sprintId and action (retry/skip/stop) are required' });
  }

  if (!['retry', 'skip', 'stop'].includes(action)) {
    return res.status(400).json({ error: 'action must be retry, skip, or stop' });
  }

  try {
    const result = await orchestrator.handleErrorAction(sprintId, action);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}

// POST /api/pipeline/qa-fix — PO approves QA fix
export async function qaFixAction(req, res) {
  const orchestrator = req.app.get('orchestrator');
  const { sprintId, fixAll } = req.body || {};
  if (!sprintId) return res.status(400).json({ error: 'sprintId is required' });

  try {
    const result = await orchestrator.runQAFix(sprintId, { fixAll: fixAll === true });
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}

// GET /api/pipeline/health
export async function pipelineHealth(_req, res) {
  const [activeSprints, processingCount, config, stoppedSprints] = await Promise.all([
    prisma.sprint.count({ where: { status: { notIn: ['completed', 'failed'] } } }),
    prisma.sprint.count({ where: { isProcessing: true } }),
    prisma.pipelineConfig.findUnique({ where: { id: 'singleton' } }),
    prisma.sprint.findMany({
      where: { status: { notIn: ['completed', 'failed', 'pending'] }, isProcessing: false },
      select: { id: true, number: true, status: true, currentStep: true, currentGateNumber: true },
      orderBy: { updatedAt: 'desc' },
      take: 5,
    }),
  ]);

  res.json({
    status: 'ok',
    activeSprints,
    processingCount,
    stoppedSprints,
    config: config || {},
    timestamp: new Date().toISOString(),
  });
}
