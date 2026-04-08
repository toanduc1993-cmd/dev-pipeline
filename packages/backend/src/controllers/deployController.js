import prisma from '../lib/prisma.js';

// GET /api/projects/:projectId/deploy-config
export async function getDeployConfig(req, res) {
  let config = await prisma.deployConfig.findUnique({
    where: { projectId: req.params.projectId },
  });
  if (!config) {
    config = await prisma.deployConfig.create({
      data: { projectId: req.params.projectId },
    });
  }
  // Mask sensitive fields
  const masked = { ...config };
  if (masked.vercelToken) masked.vercelToken = '***' + masked.vercelToken.slice(-4);
  if (masked.uatDbUrl) masked.uatDbUrl = masked.uatDbUrl.replace(/:\/\/[^@]+@/, '://***@');
  if (masked.gitToken) masked.gitToken = '***' + masked.gitToken.slice(-4);
  res.json(masked);
}

// PUT /api/projects/:projectId/deploy-config
export async function updateDeployConfig(req, res) {
  const { projectId } = req.params;
  const data = req.body;

  // Remove read-only fields
  delete data.id;
  delete data.projectId;
  delete data.createdAt;
  delete data.updatedAt;

  const config = await prisma.deployConfig.upsert({
    where: { projectId },
    create: { projectId, ...data },
    update: data,
  });
  res.json(config);
}

// POST /api/projects/:projectId/local-setup — trigger local setup
export async function triggerLocalSetup(req, res) {
  const orchestrator = req.app.get('orchestrator');
  const project = await prisma.project.findUnique({ where: { id: req.params.projectId } });
  if (!project) return res.status(404).json({ error: 'Project not found' });

  try {
    const result = await orchestrator.runner.runLocalSetup(project);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

// POST /api/projects/:projectId/uat-deploy — trigger UAT deploy
export async function triggerUATDeploy(req, res) {
  const orchestrator = req.app.get('orchestrator');
  const project = await prisma.project.findUnique({ where: { id: req.params.projectId } });
  if (!project) return res.status(404).json({ error: 'Project not found' });

  const config = await prisma.deployConfig.findUnique({ where: { projectId: project.id } });
  if (!config) return res.status(400).json({ error: 'Deploy config not set. Configure in Settings first.' });

  try {
    const result = await orchestrator.runner.runUATDeploy(project, config);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

// POST /api/projects/:projectId/plan-sprints — split large requirement into sprints
export async function planSprints(req, res) {
  const orchestrator = req.app.get('orchestrator');
  const project = await prisma.project.findUnique({ where: { id: req.params.projectId } });
  if (!project) return res.status(404).json({ error: 'Project not found' });

  const { requirement } = req.body || {};
  if (!requirement) return res.status(400).json({ error: 'requirement is required' });

  res.json({ ok: true, message: 'Sprint planning started...' });

  setImmediate(async () => {
    try {
      await orchestrator.runner.planSprints(project, requirement);
    } catch (err) {
      await prisma.project.update({ where: { id: project.id }, data: { status: 'active' } }).catch(() => {});
      orchestrator._emit('qa:fix_progress', { sprintId: null, phase: 'done', message: 'Planning failed' });
      await orchestrator.notif.send({
        projectId: project.id,
        type: 'pipeline_error',
        title: 'Sprint planning failed',
        message: err.message,
      });
    }
  });
}

// POST /api/projects/:projectId/bugfix — report bug and auto-fix
export async function triggerBugfix(req, res) {
  const orchestrator = req.app.get('orchestrator');
  const project = await prisma.project.findUnique({ where: { id: req.params.projectId } });
  if (!project) return res.status(404).json({ error: 'Project not found' });

  const { errorDescription } = req.body || {};
  if (!errorDescription) return res.status(400).json({ error: 'errorDescription is required' });

  res.json({ ok: true, message: 'Bugfix started — Claude is diagnosing...' });

  // Run async
  setImmediate(async () => {
    try {
      await orchestrator.runner.runBugfix(project, errorDescription);
    } catch (err) {
      await orchestrator.notif.send({
        projectId: project.id,
        type: 'pipeline_error',
        title: 'Bugfix that bai',
        message: err.message,
      });
    }
  });
}
