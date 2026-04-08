import { Router } from 'express';
import { asyncWrap } from '../middleware/asyncWrap.js';
import {
  getDeployConfig, updateDeployConfig, triggerLocalSetup, triggerUATDeploy, triggerBugfix, planSprints,
} from '../controllers/deployController.js';

const router = Router();

router.get('/projects/:projectId/deploy-config', asyncWrap(getDeployConfig));
router.put('/projects/:projectId/deploy-config', asyncWrap(updateDeployConfig));
router.post('/projects/:projectId/local-setup', asyncWrap(triggerLocalSetup));
router.post('/projects/:projectId/uat-deploy', asyncWrap(triggerUATDeploy));
router.post('/projects/:projectId/bugfix', asyncWrap(triggerBugfix));
router.post('/projects/:projectId/plan-sprints', asyncWrap(planSprints));

export default router;
