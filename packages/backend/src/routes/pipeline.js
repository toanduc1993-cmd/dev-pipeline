import { Router } from 'express';
import { asyncWrap } from '../middleware/asyncWrap.js';
import {
  pausePipeline, resumePipeline, resumeSprint, handleErrorAction, qaFixAction, pipelineHealth,
} from '../controllers/pipelineController.js';

const router = Router();

router.post('/pause', asyncWrap(pausePipeline));
router.post('/resume', asyncWrap(resumePipeline));
router.post('/error-action', asyncWrap(handleErrorAction));
router.post('/qa-fix', asyncWrap(qaFixAction));
router.get('/health', asyncWrap(pipelineHealth));

export default router;
