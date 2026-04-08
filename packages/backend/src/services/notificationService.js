import prisma from '../lib/prisma.js';
import logger from '../lib/logger.js';

export class NotificationService {
  constructor(io, bot) {
    this.io = io;
    this.bot = bot;
  }

  /**
   * Send notification: save to DB + emit socket + telegram (if enabled).
   */
  async send({ projectId, sprintId, type, title, message, payload = null }) {
    const config = await prisma.pipelineConfig.findUnique({ where: { id: 'singleton' } });

    // Save to DB
    const notif = await prisma.notification.create({
      data: {
        projectId: projectId || null,
        sprintId: sprintId || null,
        type,
        title,
        message,
        payload: payload ? JSON.stringify(payload) : null,
        channel: 'both',
      },
    });

    // Emit via Socket.io
    this.io?.emit('notification:new', { id: notif.id, type, title, message });

    // Telegram (lazy import to avoid circular deps)
    if (config?.telegramEnabled && this.bot) {
      try {
        const { sendTelegramNotification } = await import('../bot/index.js');
        const parsedPayload = payload || (notif.payload ? JSON.parse(notif.payload) : null);
        await sendTelegramNotification(this.bot, { title, message, type, payload: parsedPayload });
      } catch (err) {
        logger.warn({ err: err.message }, 'Telegram notification failed');
      }
    }

    return notif;
  }
}
