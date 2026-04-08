import { Router } from 'express';
import { asyncWrap } from '../middleware/asyncWrap.js';
import {
  getConfig, updateConfig, verifyClaude, verifyGit,
} from '../controllers/configController.js';

const router = Router();

router.get('/', asyncWrap(getConfig));
router.put('/', asyncWrap(updateConfig));
router.post('/verify-claude', asyncWrap(verifyClaude));
router.post('/verify-git', asyncWrap(verifyGit));

export default router;
