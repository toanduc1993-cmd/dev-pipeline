import { Router } from 'express';
import { asyncWrap } from '../middleware/asyncWrap.js';
import {
  listSprints, createSprint, getSprint, getSprintPipeline,
} from '../controllers/sprintController.js';
import { resumeSprint } from '../controllers/pipelineController.js';

const router = Router();

// Nested under projects
router.get('/projects/:projectId/sprints', asyncWrap(listSprints));
router.post('/projects/:projectId/sprints', asyncWrap(createSprint));

// Direct sprint access
router.get('/sprints/:id', asyncWrap(getSprint));
router.get('/sprints/:id/pipeline', asyncWrap(getSprintPipeline));
router.post('/sprints/:id/resume', asyncWrap(resumeSprint));

export default router;
