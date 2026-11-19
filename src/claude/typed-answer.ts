/**
 * Typed answers to telecoder_ask_user: Claude Code's "Type something" row.
 *
 * Claude Code's own question dialog ends on a row where you type an answer of
 * your own instead of picking one. A Telegram keyboard has no text field, so
 * here the answer is an ordinary message: while a question is open, the next
 * text sent in its chat or thread answers it. A reply to a question picks that
 * one, should several be open; anything else answers the one asked last. In a
 * form it answers the question on screen.
 *
 * Before this, a message sent while a question was open waited behind the
 * turn, which was itself waiting on a tap, so nothing happened until the
 * question timed out.
 *
 * {@link captureTypedAnswers} takes the message out of the update stream ahead
 * of the batcher, the queue and sequentialize, for the reason secret-request.ts
 * gives: an answer waiting behind the turn that asked would never arrive.
 * Commands pass, so /cancel, /steer and /later still work.
 *
 * Only telecoder_ask_user opens a question to typed answers. TeleCoder's own
 * questions (the permission gate, the memory guard, a held message) have fixed
 * outcomes and take a tap.
 */

import type { Context, MiddlewareFn } from 'grammy';
import { clip } from '../telegram/entities.js';
import { repliedForceReplyFlow } from '../telegram/force-reply-tracker.js';
import { getSessionKeyFromCtx } from '../utils/session-key.js';

/** The line a question ends on, saying it takes a typed answer. */
export const TYPED_ANSWER_HINT = '✏️ Or reply with your own answer.';

/** Longest stretch of a typed answer written back into a question's message. */
const MAX_SHOWN_CHARS = 200;

export interface TypedAnswerTaker {
  sessionKey: string;
  chatId: number;
  /** The question's message: a reply to it reaches this taker. */
  messageId: number;
  /**
   * Hand over a message as the answer. False when the question can't take it
   * after all, such as one a tap answered a moment ago, and the message goes
   * on as an ordinary one.
   */
  take(ctx: Context, text: string): Promise<boolean>;
}

/** Open questions, in the order they were asked. */
const takers: TypedAnswerTaker[] = [];

/**
 * Open a question to typed answers, once its message is posted. Returns the
 * call that closes it again, which is safe to make more than once.
 */
export function acceptTypedAnswers(taker: TypedAnswerTaker): () => void {
  takers.push(taker);
  return () => {
    const i = takers.indexOf(taker);
    if (i !== -1) takers.splice(i, 1);
  };
}

/**
 * Stop taking messages as answers in this session, as /cancel does. The
 * question itself closes once claude has cancelled the tool call, which takes
 * a moment, and the message after /cancel must not land in it meanwhile.
 */
export function stopTypedAnswers(sessionKey: string): void {
  for (let i = takers.length - 1; i >= 0; i--) {
    if (takers[i].sessionKey === sessionKey) takers.splice(i, 1);
  }
}

/** Whether this message is an open question. In a group, a reply to one addresses the bot. */
export function isOpenQuestionMessage(chatId: number, messageId: number): boolean {
  return takers.some((t) => t.chatId === chatId && t.messageId === messageId);
}

/** The question a message in this session answers: the one it replies to, or else the one asked last. */
export function pickTaker(sessionKey: string, replyToId?: number): TypedAnswerTaker | undefined {
  const open = takers.filter((t) => t.sessionKey === sessionKey);
  return open.find((t) => t.messageId === replyToId) ?? open.at(-1);
}

/** A typed answer as a question's message shows it: on one line, and clipped. */
export function shownTypedAnswer(text: string): string {
  return `✏️ ${clip(text.replace(/\s+/g, ' ').trim(), MAX_SHOWN_CHARS)}`;
}

/**
 * Mark the message that answered a question. The question's own message
 * changes too, but an edit is silent and may be scrolled out of view; the
 * sender looks for the answer where they typed it.
 */
export async function acknowledgeTypedAnswer(ctx: Context): Promise<void> {
  try {
    await ctx.react('👌');
  } catch {
    // Cosmetic: a group can turn reactions off, and the question still records the answer.
  }
}

/**
 * Hand a text message to the open question it answers, and nothing after this
 * middleware sees it. Registered after the secret capture and ahead of the
 * batcher, the queue and sequentialize. An answer to one of the bot's
 * ForceReply prompts goes on to the flow that asked.
 */
export const captureTypedAnswers: MiddlewareFn<Context> = async (ctx, next) => {
  const message = ctx.message;
  const text = message?.text;
  if (!message || text === undefined || text.startsWith('/') || repliedForceReplyFlow(ctx)) return next();

  const keyInfo = getSessionKeyFromCtx(ctx);
  const taker = keyInfo ? pickTaker(keyInfo.sessionKey, message.reply_to_message?.message_id) : undefined;
  if (!taker || !(await taker.take(ctx, text))) return next();
};

/** For tests: forget every open question. */
export function _resetTypedAnswersForTests(): void {
  takers.length = 0;
}
