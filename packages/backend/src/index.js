import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { createServer } from 'http';
import { Server as SocketIOServer } from 'socket.io';
import logger from './lib/logger.js';
import { errorHandler } from './middleware/errorHandler.js';
import projectRoutes from './routes/projects.js';
import sprintRoutes from './routes/sprints.js';
import gateRoutes from './routes/gates.js';
import taskRoutes from './routes/tasks.js';
import notificationRoutes from './routes/notifications.js';
import configRoutes from './routes/config.js';
import pipelineRoutes from './routes/pipeline.js';
import agentRoutes from './routes/agents.js';
import uploadRoutes from './routes/upload.js';
import deployRoutes from './routes/deploy.js';
import { Orchestrator } from './services/orchestrator/index.js';
import { createBot } from './bot/index.js';
import { authMiddleware } from './middleware/auth.js';
import prisma from './lib/prisma.js';

const app = express();
const httpServer = createServer(app);

const io = new SocketIOServer(httpServer, {
  cors: {
    origin: process.env.FRONTEND_URL || 'http://localhost:5173',
    methods: ['GET', 'POST'],
  },
});

// Middleware
app.use(cors({ origin: process.env.FRONTEND_URL || 'http://localhost:5173' }));
app.use(express.json({ limit: '10mb' }));
app.use(authMiddleware);

// Health check
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Routes
app.use('/api/projects', projectRoutes);
app.use('/api', sprintRoutes);
app.use('/api', gateRoutes);
app.use('/api', taskRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/config', configRoutes);
app.use('/api/pipeline', pipelineRoutes);
app.use('/api/agents', agentRoutes);
app.use('/api/upload', uploadRoutes);
app.use('/api', deployRoutes);

// Orchestrator + Telegram bot
// Create orchestrator first (bot=null), then bot with orchestrator, then assign bot back
const orchestrator = new Orchestrator(io, null);
const bot = createBot(orchestrator);
if (bot) orchestrator.notif.bot = bot;
app.set('orchestrator', orchestrator);

// Error handler (must be last)
app.use(errorHandler);

// Socket.io auth
io.use((socket, next) => {
  const secret = process.env.API_SECRET;
  if (!secret) return next();
  const token = socket.handshake.auth?.token
    || socket.handshake.headers?.authorization?.replace('Bearer ', '');
  if (!token || token !== secret) return next(new Error('Unauthorized'));
  next();
});

io.on('connection', (socket) => {
  logger.info({ socketId: socket.id }, 'Client connected');
  socket.on('subscribe:sprint', ({ sprintId }) => {
    socket.join(`sprint:${sprintId}`);
  });
  socket.on('disconnect', () => {
    logger.debug({ socketId: socket.id }, 'Client disconnected');
  });
});

const PORT = process.env.PORT || 3001;

async function clearStaleLocks() {
  const stale = await prisma.sprint.findMany({
    where: { isProcessing: true },
    select: { id: true, number: true, currentStep: true, claudePid: true },
  });
  if (stale.length > 0) {
    // Kill orphan Claude subprocesses
    for (const s of stale) {
      if (s.claudePid) {
        try {
          process.kill(s.claudePid, 'SIGTERM');
          logger.info({ pid: s.claudePid, sprintId: s.id }, 'Killed orphan Claude subprocess on startup');
        } catch {
          // Process already dead — ok
        }
      }
    }
    await prisma.sprint.updateMany({
      where: { isProcessing: true },
      data: { isProcessing: false, claudePid: null },
    });
    logger.warn(
      { count: stale.length, sprints: stale.map((s) => `#${s.number} (step ${s.currentStep})`) },
      'Cleared stale locks on startup — use POST /api/pipeline/resume or /resume in Telegram to continue'
    );
  }
}

async function ensurePipelineConfig() {
  await prisma.pipelineConfig.upsert({
    where: { id: 'singleton' },
    create: {
      id: 'singleton',
      maxParallelAgents: parseInt(process.env.MAX_PARALLEL_AGENTS || '1'),
      maxRetryRounds: parseInt(process.env.MAX_RETRY_ROUNDS || '3'),
      taskTimeoutMins: parseInt(process.env.TASK_TIMEOUT_MINS || '45'),
      qaChunkSize: parseInt(process.env.QA_CHUNK_SIZE || '5'),
      telegramEnabled: process.env.TELEGRAM_BOT_TOKEN ? true : false,
    },
    update: {}, // Don't override if already exists — DB is source of truth
  });
}

async function startServer() {
  await clearStaleLocks();
  await ensurePipelineConfig();
  httpServer.listen(PORT, () => {
    logger.info({ port: PORT }, 'AI Dev Pipeline backend running');
  });
}

startServer().catch((err) => {
  logger.error({ err }, 'Failed to start server');
  process.exit(1);
});

export { app, io, httpServer, orchestrator };
