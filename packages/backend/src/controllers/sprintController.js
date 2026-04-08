import prisma from '../lib/prisma.js';
import { GATE_DEFINITIONS } from '../lib/constants.js';
import logger from '../lib/logger.js';

// GET /api/projects/:projectId/sprints
export async function listSprints(req, res) {
  const sprints = await prisma.sprint.findMany({
    where: { projectId: req.params.projectId },
    orderBy: { number: 'desc' },
    include: { _count: { select: { tasks: true, gates: true } } },
  });
  res.json(sprints);
}

// POST /api/projects/:projectId/sprints
export async function createSprint(req, res) {
  const { projectId } = req.params;
  const { name, requirementText, requirementFile } = req.body;

  const project = await prisma.project.findUnique({ where: { id: projectId } });
  if (!project) return res.status(404).json({ error: 'Project not found' });
  if (!name) return res.status(400).json({ error: 'name is required' });

  // Auto-increment sprint number
  const last = await prisma.sprint.findFirst({
    where: { projectId },
    orderBy: { number: 'desc' },
  });
  const nextNumber = last ? last.number + 1 : 1;

  const sprint = await prisma.sprint.create({
    data: {
      projectId,
      number: nextNumber,
      name,
      requirementText: requirementText || null,
      requirementFile: requirementFile || null,
    },
  });

  // Create all 7 gates
  const gateData = Object.entries(GATE_DEFINITIONS).map(([num, def]) => ({
    sprintId: sprint.id,
    gateNumber: parseInt(num),
    title: def.title,
    description: def.title,
    status: 'pending',
  }));
  await prisma.gate.createMany({ data: gateData });

  // Sprint starts as running_step — Step 0 Reception will run automatically
  await prisma.sprint.update({
    where: { id: sprint.id },
    data: { status: 'running_step', currentGateNumber: 0, currentStep: 0 },
  });

  const full = await prisma.sprint.findUnique({
    where: { id: sprint.id },
    include: { gates: { orderBy: { gateNumber: 'asc' } }, tasks: true },
  });
  res.status(201).json(full);

  // Trigger Step 0 Reception automatically (async, non-blocking)
  const orchestrator = req.app.get('orchestrator');
  if (orchestrator) {
    setImmediate(async () => {
      try {
        const fullSprint = await prisma.sprint.findUnique({
          where: { id: sprint.id },
          include: { project: true, gates: { orderBy: { gateNumber: 'asc' } } },
        });
        await orchestrator.runner._step0_Reception(fullSprint);
      } catch (err) {
        logger.error({ err: err.message, sprintId: sprint.id }, 'Step 0 Reception failed');
        // Set sprint to waiting so PO can see something
        await prisma.sprint.update({
          where: { id: sprint.id },
          data: { status: 'waiting_gate', isProcessing: false },
        });
        await prisma.gate.update({
          where: { sprintId_gateNumber: { sprintId: sprint.id, gateNumber: 0 } },
          data: { status: 'waiting_approval', notes: `Reception Report failed: ${err.message}. Approve to proceed to Architect step.` },
        });
      }
    });
  }
}

// GET /api/sprints/:id
export async function getSprint(req, res) {
  const sprint = await prisma.sprint.findUnique({
    where: { id: req.params.id },
    include: {
      project: true,
      gates: { orderBy: { gateNumber: 'asc' } },
      tasks: { orderBy: { taskId: 'asc' } },
    },
  });
  if (!sprint) return res.status(404).json({ error: 'Sprint not found' });
  res.json(sprint);
}

// GET /api/sprints/:id/pipeline — full pipeline state
export async function getSprintPipeline(req, res) {
  const sprint = await prisma.sprint.findUnique({
    where: { id: req.params.id },
    include: {
      project: true,
      gates: { orderBy: { gateNumber: 'asc' } },
      tasks: {
        orderBy: { taskId: 'asc' },
        include: { _count: { select: { logs: true } } },
      },
    },
  });
  if (!sprint) return res.status(404).json({ error: 'Sprint not found' });
  res.json(sprint);
}
