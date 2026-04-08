import { Router } from 'express';
import { asyncWrap } from '../middleware/asyncWrap.js';
import { listAgents, getAgentLogs } from '../controllers/agentController.js';

const router = Router();

router.get('/', asyncWrap(listAgents));
router.get('/:slot/logs', asyncWrap(getAgentLogs));

export default router;
