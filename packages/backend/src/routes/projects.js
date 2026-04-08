import { Router } from 'express';
import { asyncWrap } from '../middleware/asyncWrap.js';
import {
  listProjects, createProject, getProject, updateProject, deleteProject, scanRepos,
} from '../controllers/projectController.js';

const router = Router();

router.get('/', asyncWrap(listProjects));
router.get('/scan-repos', asyncWrap(scanRepos));
router.post('/', asyncWrap(createProject));
router.get('/:id', asyncWrap(getProject));
router.put('/:id', asyncWrap(updateProject));
router.delete('/:id', asyncWrap(deleteProject));

export default router;
