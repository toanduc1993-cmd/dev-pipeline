import prisma from '../lib/prisma.js';

// GET /api/sprints/:sprintId/gates
export async function listGates(req, res) {
  const gates = await prisma.gate.findMany({
    where: { sprintId: req.params.sprintId },
    orderBy: { gateNumber: 'asc' },
  });
  res.json(gates);
}

// GET /api/gates/:id
export async function getGate(req, res) {
  const gate = await prisma.gate.findUnique({
    where: { id: req.params.id },
    include: { sprint: { include: { project: true } } },
  });
  if (!gate) return res.status(404).json({ error: 'Gate not found' });
  res.json(gate);
}

// POST /api/gates/:id/approve — calls orchestrator.onGateApproved()
export async function approveGate(req, res) {
  const orchestrator = req.app.get('orchestrator');
  const { comment } = req.body || {};

  try {
    await orchestrator.onGateApproved(req.params.id, { comment, approvedBy: 'web' });
    res.json({ message: 'Gate approved, pipeline triggered' });
  } catch (err) {
    const status = err.message.includes('not found') ? 404
      : err.message.includes('not waiting') ? 400
      : err.message.includes('processing') ? 409
      : 400;
    res.status(status).json({ error: err.message });
  }
}

// POST /api/gates/:id/reject — calls orchestrator.onGateRejected()
export async function rejectGate(req, res) {
  const orchestrator = req.app.get('orchestrator');
  const { reason } = req.body || {};
  if (!reason) return res.status(400).json({ error: 'reason is required' });

  try {
    await orchestrator.onGateRejected(req.params.id, { reason, rejectedBy: 'web' });
    res.json({ message: 'Gate rejected' });
  } catch (err) {
    const status = err.message.includes('not found') ? 404 : 400;
    res.status(status).json({ error: err.message });
  }
}

// POST /api/gates/:id/request-changes — alias for reject with structured reason
export async function requestChanges(req, res) {
  const orchestrator = req.app.get('orchestrator');
  const { changes } = req.body || {};
  if (!changes) return res.status(400).json({ error: 'changes is required' });

  try {
    await orchestrator.onGateRejected(req.params.id, {
      reason: `[REQUEST CHANGES] ${changes}`,
      rejectedBy: 'web',
    });
    res.json({ message: 'Changes requested' });
  } catch (err) {
    const status = err.message.includes('not found') ? 404 : 400;
    res.status(status).json({ error: err.message });
  }
}
