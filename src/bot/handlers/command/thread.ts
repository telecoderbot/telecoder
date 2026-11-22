/**
 * /deletethread: delete the thread it's sent in, messages and all, and end
 * the session that belonged to it. Works in a private chat's threads and, for
 * a bot allowed to delete messages there, in a group's forum topics.
 *
 * /keep: mark the thread it's sent in so /cleanup leaves it alone, with a 📌
 * in front of its name where the bot names it. `/keep off` takes it off.
 *
 * It answers mid-turn, since stopping that turn is part of the point. The
 * thread goes first and its session after, so a thread Telegram won't delete
 * keeps a session that works.
 */

import { Api, Context, GrammyError } from 'grammy';
import { EntityText } from '../../../telegram/entities.js';
import { replyFormatted, editCallbackMessage } from '../../../telegram/send.js';
import { getSessionKeyFromCtx, parseSessionKey } from '../../../utils/session-key.js';
import { sanitizeError } from '../../../utils/sanitize.js';
import { forgetThread, isThreadGoneError } from '../../deleted-threads.js';
import { KEEP_MARK, isThreadKept, setThreadKept } from '../../kept-threads.js';
import { markThreadName } from '../../../telegram/thread-titles.js';
import { parseCallback } from './shared.js';

const SKIP_CONFIRM = new Set(['-y', '--yes', 'yes', 'force']);

/**
 * Delete the thread, then let its session go. What went wrong, or null. Also
 * what /cleanup deletes each thread with.
 */
export async function deleteThread(api: Api, sessionKey: string, why = '/deletethread'): Promise<string | null> {
  const { chatId, threadId } = parseSessionKey(sessionKey);
  if (threadId === undefined) return 'not a thread';
  try {
    await api.deleteForumTopic(chatId, threadId);
  } catch (err) {
    // Already gone, deleted by hand since the confirmation was sent: let go all the same.
    if (!(err instanceof GrammyError && isThreadGoneError(err.description))) {
      console.error(`[DeleteThread] Deleting ${sessionKey} failed:`, sanitizeError(err));
      return err instanceof GrammyError ? err.description : 'Telegram refused';
    }
  }
  await forgetThread(api, sessionKey, why);
  return null;
}

export async function handleDeleteThread(ctx: Context): Promise<void> {
  const keyInfo = getSessionKeyFromCtx(ctx);
  if (!keyInfo) return;
  const { threadId, sessionKey } = keyInfo;

  if (threadId === undefined) {
    await ctx.reply('ℹ️ Send /deletethread inside the thread you want to delete.');
    return;
  }

  const arg = (ctx.message?.text ?? '').split(' ').slice(1).join(' ').trim().toLowerCase();
  if (SKIP_CONFIRM.has(arg)) {
    const failed = await deleteThread(ctx.api, sessionKey);
    if (failed) await ctx.reply(`❌ Couldn't delete this thread: ${failed}`);
    return;
  }

  const confirm = new EntityText()
    .add('⚠️ ').bold('Delete this thread?')
    .add('\n\nThe thread and all its messages are removed from Telegram, and its Claude session ends. ')
    .add('The conversation itself stays on disk, so ').code('/resume').add(' can still pick it up.\n\n')
    .italic('Telegram can\'t undo this.')
    .add('\n\n💡 Tip: ').code('/deletethread -y').add(' skips this confirmation.')
    .build();

  await replyFormatted(ctx, confirm, {
    reply_markup: {
      inline_keyboard: [[
        { text: '🗑️ Yes, delete it', callback_data: 'delthread:confirm' },
        { text: '✗ Cancel', callback_data: 'delthread:cancel' },
      ]],
    },
  });
}

export async function handleDeleteThreadCallback(ctx: Context): Promise<void> {
  const cb = parseCallback(ctx, 'delthread:');
  if (!cb) return;
  const { threadId, sessionKey, data } = cb;

  if (data !== 'delthread:confirm' || threadId === undefined) {
    await ctx.answerCallbackQuery({ text: 'Kept the thread.' }).catch(() => {});
    await editCallbackMessage(ctx, new EntityText().add('👍 Kept the thread.').build()).catch(() => {});
    return;
  }

  const failed = await deleteThread(ctx.api, sessionKey);
  if (failed) {
    await ctx.answerCallbackQuery({ text: 'Couldn\'t delete the thread.' }).catch(() => {});
    await editCallbackMessage(ctx, new EntityText().add(`❌ Couldn't delete this thread: ${failed}`).build()).catch(() => {});
    return;
  }
  await ctx.answerCallbackQuery({ text: 'Thread deleted.' }).catch(() => {});
}

const KEEP_OFF = new Set(['off', 'no', 'remove', 'undo']);

export async function handleKeep(ctx: Context): Promise<void> {
  const keyInfo = getSessionKeyFromCtx(ctx);
  if (!keyInfo) return;
  const { threadId, sessionKey } = keyInfo;

  if (threadId === undefined) {
    await ctx.reply('ℹ️ Send /keep inside the thread you want to keep.');
    return;
  }

  const arg = (ctx.message?.text ?? '').split(' ').slice(1).join(' ').trim().toLowerCase();
  const keep = !KEEP_OFF.has(arg);

  if (!keep) {
    if (!setThreadKept(sessionKey, false)) {
      await replyFormatted(ctx, new EntityText().add('ℹ️ This thread wasn\'t kept, so ').code('/cleanup').add(' can already offer it.').build());
      return;
    }
    await markThreadName(sessionKey, KEEP_MARK, false);
    await replyFormatted(ctx, new EntityText().add('👍 Not kept any more: ').code('/cleanup').add(' can offer this thread again.').build());
    return;
  }

  if (isThreadKept(sessionKey)) {
    await replyFormatted(ctx, new EntityText()
      .add('📌 This thread is already kept. ').code('/keep off').add(' lets ').code('/cleanup').add(' offer it again.').build());
    return;
  }
  setThreadKept(sessionKey, true);
  const named = await markThreadName(sessionKey, KEEP_MARK, true);
  const text = new EntityText().add('📌 ').bold('Kept.').add(' ').code('/cleanup').add(' leaves this thread alone; ')
    .code('/keep off').add(' undoes it.');
  if (named === 'user-named') text.newline(2).italic('The thread\'s name is the one you gave it, so it stays as it is, without the 📌.');
  await replyFormatted(ctx, text.build());
}
