import prisma from '../lib/prisma.js';

// GET /api/notifications — paginated
export async function listNotifications(req, res) {
  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 20;
  const skip = (page - 1) * limit;

  const [notifications, total] = await Promise.all([
    prisma.notification.findMany({
      orderBy: { createdAt: 'desc' },
      skip,
      take: limit,
    }),
    prisma.notification.count(),
  ]);

  res.json({ notifications, total, page, limit });
}

// POST /api/notifications/:id/read
export async function markRead(req, res) {
  const notif = await prisma.notification.findUnique({ where: { id: req.params.id } });
  if (!notif) return res.status(404).json({ error: 'Notification not found' });

  const updated = await prisma.notification.update({
    where: { id: req.params.id },
    data: { read: true },
  });
  res.json(updated);
}

// POST /api/notifications/read-all
export async function markAllRead(_req, res) {
  await prisma.notification.updateMany({
    where: { read: false },
    data: { read: true },
  });
  res.json({ ok: true });
}
