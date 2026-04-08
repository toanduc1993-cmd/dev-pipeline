import { Router } from 'express';
import { asyncWrap } from '../middleware/asyncWrap.js';
import {
  listTasks, getTask, getTaskLogs, overridePass, retryTask,
} from '../controllers/taskController.js';

const router = Router();

router.get('/sprints/:sprintId/tasks', asyncWrap(listTasks));
router.get('/tasks/:id', asyncWrap(getTask));
router.get('/tasks/:id/logs', asyncWrap(getTaskLogs));
router.post('/tasks/:id/override-pass', asyncWrap(overridePass));
router.post('/tasks/:id/retry', asyncWrap(retryTask));

export default router;
