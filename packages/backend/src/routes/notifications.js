import { Router } from 'express';
import { asyncWrap } from '../middleware/asyncWrap.js';
import {
  listNotifications, markRead, markAllRead,
} from '../controllers/notificationController.js';

const router = Router();

router.get('/', asyncWrap(listNotifications));
router.post('/read-all', asyncWrap(markAllRead));
router.post('/:id/read', asyncWrap(markRead));

export default router;
