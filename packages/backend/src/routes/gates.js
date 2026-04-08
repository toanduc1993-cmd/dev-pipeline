import { Router } from 'express';
import { asyncWrap } from '../middleware/asyncWrap.js';
import {
  listGates, getGate, approveGate, rejectGate, requestChanges,
} from '../controllers/gateController.js';

const router = Router();

router.get('/sprints/:sprintId/gates', asyncWrap(listGates));
router.get('/gates/:id', asyncWrap(getGate));
router.post('/gates/:id/approve', asyncWrap(approveGate));
router.post('/gates/:id/reject', asyncWrap(rejectGate));
router.post('/gates/:id/request-changes', asyncWrap(requestChanges));

export default router;
