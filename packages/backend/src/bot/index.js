import { Bot, InlineKeyboard } from 'grammy';
import prisma from '../lib/prisma.js';
import logger from '../lib/logger.js';

let botInstance = null;

/**
 * Create and start the Telegram bot.
 * @param {import('../services/orchestrator/index.js').Orchestrator} orchestrator
 */
export function createBot(orchestrator) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_PO_CHAT_ID;
  if (!token || !chatId) {
    logger.warn('Telegram disabled (no token or chatId)');
    return null;
  }

  const bot = new Bot(token);
  botInstance = bot;

  // Security middleware — only respond to PO chat
  bot.use(async (ctx, next) => {
    if (ctx.chat?.id?.toString() !== chatId) return;
    await next();
  });

  // ─── /start ──────────────────────────────────────────────
  bot.command('start', async (ctx) => {
    await ctx.reply(
      '*AI Dev Pipeline Bot*\nI will notify you at each gate and wait for your approval.\nUse /help for commands.',
      { parse_mode: 'Markdown' }
    );
  });

  // ─── /help ───────────────────────────────────────────────
  bot.command('help', async (ctx) => {
    await ctx.reply(
      '*Commands:*\n' +
      '/status — Active sprints + pending gates\n' +
      '/progress — Task progress bar\n' +
      '/agents — DEV-1/2/3 status\n' +
      '/approve \\[gate\\_id\\] — Approve gate\n' +
      '/reject \\[gate\\_id\\] \\[reason\\] — Reject gate\n' +
      '/resume — Resume interrupted sprint\n' +
      '/help — This message',
      { parse_mode: 'MarkdownV2' }
    );
  });

  // ─── /status ─────────────────────────────────────────────
  bot.command('status', async (ctx) => {
    const sprints = await prisma.sprint.findMany({
      where: { status: { notIn: ['completed', 'failed'] } },
      include: { project: true, gates: { orderBy: { gateNumber: 'asc' } } },
      take: 3,
      orderBy: { updatedAt: 'desc' },
    });

    if (sprints.length === 0) {
      return ctx.reply('No active sprints.');
    }

    for (const sprint of sprints) {
      const emoji = { running_step: '⚡', waiting_gate: '⏳', waiting_human: '🚨' }[sprint.status] || '◻';
      const pendingGate = sprint.gates.find((g) => g.status === 'waiting_approval');

      let msg = `${emoji} *${sprint.project.name}* — Sprint #${sprint.number}\n`;
      msg += `Status: \`${sprint.status}\` Step: ${sprint.currentStep}/6\n`;

      if (pendingGate) {
        msg += `\n🔐 *Gate ${pendingGate.gateNumber}: ${pendingGate.title}*\nWaiting for your approval`;
        const kb = new InlineKeyboard()
          .text('✅ Approve', `approve:${pendingGate.id}`)
          .text('👁 View', `view:${pendingGate.id}`)
          .row()
          .text('❌ Reject', `reject:${pendingGate.id}`);
        await ctx.reply(msg, { parse_mode: 'Markdown', reply_markup: kb });
      } else {
        await ctx.reply(msg, { parse_mode: 'Markdown' });
      }
    }
  });

  // ─── /progress ───────────────────────────────────────────
  bot.command('progress', async (ctx) => {
    const sprint = await prisma.sprint.findFirst({
      where: { status: { notIn: ['completed', 'failed'] } },
      include: { project: true, tasks: true },
      orderBy: { updatedAt: 'desc' },
    });

    if (!sprint) return ctx.reply('No active sprint.');

    const tasks = sprint.tasks;
    const total = tasks.length;
    const pass = tasks.filter((t) => t.status === 'pass').length;
    const running = tasks.filter((t) => ['running', 'validating', 'reviewing'].includes(t.status)).length;
    const pending = tasks.filter((t) => t.status === 'pending').length;
    const failed = tasks.filter((t) => t.status === 'fail').length;
    const escalated = tasks.filter((t) => t.status === 'escalated').length;
    const pct = total > 0 ? Math.round((pass / total) * 100) : 0;
    const bar = '█'.repeat(Math.round(pct / 10)) + '░'.repeat(10 - Math.round(pct / 10));

    let msg = `📊 *${sprint.project.name}* — Sprint #${sprint.number}\n\n`;
    msg += `\`${bar}\` ${pct}%\n\n`;
    msg += `✅ Pass: ${pass}\n⚡ Running: ${running}\n⏳ Pending: ${pending}\n`;
    if (failed > 0) msg += `❌ Failed: ${failed}\n`;
    if (escalated > 0) msg += `🚨 Escalated: ${escalated}\n`;
    msg += `\n📦 Total: ${pass}/${total}`;

    await ctx.reply(msg, { parse_mode: 'Markdown' });
  });

  // ─── /agents ─────────────────────────────────────────────
  bot.command('agents', async (ctx) => {
    const statusEmoji = { running: '⚡', validating: '🔍', reviewing: '📋', pass: '✅', fail: '❌', escalated: '🚨', pending: '⏳' };
    let msg = '*🤖 Developer Agents*\n\n';

    for (let slot = 1; slot <= 3; slot++) {
      const task = await prisma.task.findFirst({
        where: { agentSlot: slot },
        orderBy: { updatedAt: 'desc' },
      });
      if (task && task.status !== 'pending') {
        msg += `DEV-${slot}: ${statusEmoji[task.status] || '◻'} \`${task.taskId}\` — ${task.title}\n`;
        if (task.currentRound > 0) msg += `  Round ${task.currentRound}/3\n`;
      } else {
        msg += `DEV-${slot}: 💤 Idle\n`;
      }
    }

    await ctx.reply(msg, { parse_mode: 'Markdown' });
  });

  // ─── /approve [gateId] ��─────────────────────────────────
  // ─── /resume ─────────────────────────────────────────────
  bot.command('resume', async (ctx) => {
    const sprintId = ctx.match?.trim();
    try {
      let result;
      if (sprintId) {
        result = await orchestrator.resumeSprint(sprintId);
      } else {
        const sprint = await prisma.sprint.findFirst({
          where: { status: { notIn: ['completed', 'failed', 'pending'] }, isProcessing: false },
          orderBy: { updatedAt: 'desc' },
        });
        if (!sprint) return ctx.reply('Không có sprint nào cần resume.');
        result = await orchestrator.resumeSprint(sprint.id);
      }
      await ctx.reply(`▶️ ${result.message}`);
    } catch (err) {
      await ctx.reply(`❌ ${err.message}`);
    }
  });

  // ─── /bugfix [project_name] [error description] ────────
  bot.command('bugfix', async (ctx) => {
    const match = ctx.match?.trim();
    if (!match) return ctx.reply('Usage: /bugfix [ten_project] [mo ta loi]\nVD: /bugfix "Test 2" App loi ImportError');

    // Parse: first word or quoted string = project name, rest = error
    let projectName, errorDesc;
    const quotedMatch = match.match(/^"([^"]+)"\s+([\s\S]+)/);
    if (quotedMatch) {
      projectName = quotedMatch[1];
      errorDesc = quotedMatch[2];
    } else {
      const parts = match.split(' ');
      projectName = parts[0];
      errorDesc = parts.slice(1).join(' ');
    }

    if (!errorDesc) return ctx.reply('Vui long mo ta loi. VD: /bugfix "Test 2" ImportError khi start app');

    try {
      const project = await prisma.project.findFirst({
        where: { name: { contains: projectName } },
      });
      if (!project) return ctx.reply(`Khong tim thay project "${projectName}"`);

      await ctx.reply(`🔧 Dang chan doan va fix loi cho ${project.name}...`);
      const result = await orchestrator.runner.runBugfix(project, errorDesc);

      let msg = result.status === 'FIXED'
        ? `✅ *Da fix!*\n${result.diagnosis?.rootCause || ''}\n\nFixes:\n${result.fixes?.map((f) => `- ${f.file}: ${f.description}`).join('\n') || 'Xem logs'}`
        : `⚠️ *Chua fix duoc*\n${result.diagnosis?.rootCause || result.notes || 'Xem logs'}`;
      if (result.localUrl) msg += `\n\nApp: ${result.localUrl}`;
      await ctx.reply(msg, { parse_mode: 'Markdown' });
    } catch (err) {
      await ctx.reply(`❌ Bugfix that bai: ${err.message}`);
    }
  });

  bot.command('approve', async (ctx) => {
    const gateId = ctx.match?.trim();
    if (!gateId) return ctx.reply('Usage: /approve [gate_id]');

    try {
      await orchestrator.onGateApproved(gateId, { approvedBy: 'telegram' });
      await ctx.reply('�� Gate approved. Pipeline running...');
    } catch (err) {
      await ctx.reply(`❌ Error: ${err.message}`);
    }
  });

  // ─── /reject [gateId] [reason] ──────────────────────────
  bot.command('reject', async (ctx) => {
    const parts = ctx.match?.trim().split(' ');
    const gateId = parts?.[0];
    const reason = parts?.slice(1).join(' ') || 'No reason provided';
    if (!gateId) return ctx.reply('Usage: /reject [gate_id] [reason]');

    try {
      await orchestrator.onGateRejected(gateId, { reason, rejectedBy: 'telegram' });
      await ctx.reply('❌ Gate rejected.');
    } catch (err) {
      await ctx.reply(`❌ Error: ${err.message}`);
    }
  });

  // ─── Callback queries from inline keyboards ─────────────
  bot.on('callback_query:data', async (ctx) => {
    const data = ctx.callbackQuery.data;

    if (data.startsWith('approve:')) {
      const gateId = data.replace('approve:', '');
      try {
        await orchestrator.onGateApproved(gateId, { approvedBy: 'telegram' });
        await ctx.answerCallbackQuery('✅ Approved!');
        await ctx.editMessageReplyMarkup({ reply_markup: undefined });
        await ctx.reply('✅ Gate approved. Pipeline running...');
      } catch (err) {
        await ctx.answerCallbackQuery(`❌ ${err.message}`);
      }
    } else if (data.startsWith('view:')) {
      const gateId = data.replace('view:', '');
      const gate = await prisma.gate.findUnique({ where: { id: gateId } });
      if (gate?.notes) {
        const preview = gate.notes.substring(0, 3800);
        await ctx.reply(preview + (gate.notes.length > 3800 ? '\n\n[...see full on Dashboard]' : ''));
      } else {
        await ctx.reply('No notes available for this gate.');
      }
      await ctx.answerCallbackQuery();
    } else if (data.startsWith('reject:')) {
      const gateId = data.replace('reject:', '');
      await ctx.answerCallbackQuery('Dùng: /reject ' + gateId + ' [lý do]');

    } else if (data.startsWith('error_retry:') || data.startsWith('error_skip:') || data.startsWith('error_stop:')) {
      const [prefix, sprintId] = data.split(':');
      const action = prefix.replace('error_', '');
      const labels = { retry: '🔄 Đang thử lại...', skip: '⏭ Đang bỏ qua...', stop: '🛑 Đã dừng' };
      try {
        await orchestrator.handleErrorAction(sprintId, action);
        await ctx.answerCallbackQuery(labels[action]);
        await ctx.editMessageReplyMarkup({ reply_markup: undefined });
        await ctx.reply(labels[action]);
      } catch (err) {
        await ctx.answerCallbackQuery(`❌ ${err.message}`);
      }

    } else if (data.startsWith('qa_fix:') || data.startsWith('qa_fixall:')) {
      const fixAll = data.startsWith('qa_fixall:');
      const sprintId = data.replace('qa_fixall:', '').replace('qa_fix:', '');
      try {
        await orchestrator.runQAFix(sprintId, { fixAll });
        await ctx.answerCallbackQuery(fixAll ? '🔧 Fix toàn bộ...' : '🔧 Fix lỗi chính...');
        await ctx.editMessageReplyMarkup({ reply_markup: undefined });
        await ctx.reply(fixAll ? '🔧 Đang fix toàn bộ issues (critical + major + minor)...' : '🔧 Đang fix critical + major...');
      } catch (err) {
        await ctx.answerCallbackQuery(`❌ ${err.message}`);
      }

    } else if (data.startsWith('qa_skip:')) {
      const sprintId = data.replace('qa_skip:', '');
      try {
        // Skip QA fixes — advance Gate 5 as-is
        const sprint = await prisma.sprint.findUnique({
          where: { id: sprintId },
          include: { gates: true },
        });
        const g5 = sprint.gates.find((g) => g.gateNumber === 5);
        if (g5) {
          await orchestrator.onGateApproved(g5.id, { approvedBy: 'telegram', comment: 'Bỏ qua fix, merge trực tiếp' });
        }
        await ctx.answerCallbackQuery('⏭ Bỏ qua fix, tiếp tục merge');
        await ctx.editMessageReplyMarkup({ reply_markup: undefined });
      } catch (err) {
        await ctx.answerCallbackQuery(`❌ ${err.message}`);
      }
    }
  });

  bot.start();
  logger.info('Telegram bot started');
  return bot;
}

export function getBot() {
  return botInstance;
}

/**
 * Send notification to PO via Telegram with optional inline keyboard.
 */
export async function sendTelegramNotification(bot, { title, message, type, payload }) {
  if (!bot) return;

  const chatId = process.env.TELEGRAM_PO_CHAT_ID;
  if (!chatId) return;

  const emoji = {
    gate_waiting: '🔐',
    gate_approved: '✅',
    gate_rejected: '❌',
    task_escalated: '🚨',
    sprint_complete: '🎉',
    sprint_failed: '💥',
    pipeline_error: '🚧',
    qa_fix: '🔧',
    system_error: '⚠️',
  }[type] || '📌';

  const text = `${emoji} *${title}*\n${message}`;

  try {
    if (type === 'gate_waiting' && payload?.gateId) {
      const kb = new InlineKeyboard()
        .text('✅ Duyệt', `approve:${payload.gateId}`)
        .text('👁 Xem', `view:${payload.gateId}`)
        .row()
        .text('❌ Từ chối', `reject:${payload.gateId}`);
      await bot.api.sendMessage(chatId, text, { parse_mode: 'Markdown', reply_markup: kb });

    } else if (type === 'pipeline_error' && payload?.sprintId) {
      // Include error detail in message
      const errorDetail = payload.error ? `\n\n\`${payload.error.substring(0, 500)}\`` : '';
      const fullText = `${emoji} *${title}*\n${message}${errorDetail}`;

      const kb = new InlineKeyboard()
        .text('🔄 Thử lại', `error_retry:${payload.sprintId}`)
        .text('⏭ Bỏ qua', `error_skip:${payload.sprintId}`)
        .row()
        .text('🛑 Dừng', `error_stop:${payload.sprintId}`);
      await bot.api.sendMessage(chatId, fullText.substring(0, 4000), { parse_mode: 'Markdown', reply_markup: kb });

    } else if (type === 'qa_fix' && payload?.sprintId) {
      // Load Gate 5 notes to show issues inline
      let issueDetail = '';
      try {
        if (payload.gateId) {
          const gate = await prisma.gate.findUnique({ where: { id: payload.gateId }, select: { notes: true } });
          if (gate?.notes) {
            // Extract issues from notes — strip json blocks, keep readable text
            const clean = gate.notes.replace(/```json[\s\S]*?```/g, '').replace(/```[\s\S]*?```/g, '').trim();
            issueDetail = clean.substring(0, 3000);
          }
        }
      } catch { /* ok */ }

      const fullText = `${emoji} *${title}*\n${message}${issueDetail ? '\n\n' + issueDetail : ''}`;

      const kb = new InlineKeyboard()
        .text('🔧 Fix lỗi chính', `qa_fix:${payload.sprintId}`)
        .text('🔧 Fix toàn bộ', `qa_fixall:${payload.sprintId}`)
        .row()
        .text('⏭ Bỏ qua, merge', `qa_skip:${payload.sprintId}`)
        .text('🛑 Dừng', `error_stop:${payload.sprintId}`);
      await bot.api.sendMessage(chatId, fullText.substring(0, 4000), { parse_mode: 'Markdown', reply_markup: kb });

    } else {
      await bot.api.sendMessage(chatId, text, { parse_mode: 'Markdown' });
    }
  } catch (err) {
    logger.warn({ err: err.message }, 'Failed to send Telegram message');
  }
}
