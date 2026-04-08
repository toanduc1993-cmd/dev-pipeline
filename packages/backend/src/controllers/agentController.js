import prisma from '../lib/prisma.js';

// GET /api/agents — status of DEV-1, DEV-2, DEV-3 (latest tasks)
export async function listAgents(_req, res) {
  const agents = [];

  for (let slot = 1; slot <= 3; slot++) {
    const latestTask = await prisma.task.findFirst({
      where: { agentSlot: slot },
      orderBy: { updatedAt: 'desc' },
      select: {
        id: true, taskId: true, title: true, status: true,
        currentRound: true, archVerdict: true, agentSlot: true,
        sprint: { select: { id: true, number: true, project: { select: { name: true } } } },
      },
    });

    agents.push({
      slot,
      name: `DEV-${slot}`,
      status: latestTask?.status === 'running' ? 'busy' : 'idle',
      currentTask: latestTask || null,
    });
  }

  res.json(agents);
}

// GET /api/agents/:slot/logs
export async function getAgentLogs(req, res) {
  const slot = parseInt(req.params.slot);
  if (![1, 2, 3].includes(slot)) {
    return res.status(400).json({ error: 'slot must be 1, 2, or 3' });
  }

  const tasks = await prisma.task.findMany({
    where: { agentSlot: slot },
    orderBy: { updatedAt: 'desc' },
    take: 10,
    include: {
      logs: { orderBy: { createdAt: 'desc' }, take: 5 },
      sprint: { select: { number: true, project: { select: { name: true } } } },
    },
  });

  res.json(tasks);
}
