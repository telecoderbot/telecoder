import { describe, it, expect, vi, afterEach } from 'vitest';
import type { Context } from 'grammy';
import {
  _resetTypedAnswersForTests,
  acceptTypedAnswers,
  captureTypedAnswers,
  isOpenQuestionMessage,
  pickTaker,
  shownTypedAnswer,
  stopTypedAnswers,
  type TypedAnswerTaker,
} from '../../src/claude/typed-answer.js';
import { clearForceReplyPrompts, rememberForceReplyPrompt } from '../../src/telegram/force-reply-tracker.js';

const CHAT = 42;

afterEach(() => {
  _resetTypedAnswersForTests();
  clearForceReplyPrompts();
});

/** A question open to typed answers, recording what it was handed. */
function openQuestion(messageId: number, accept = true, sessionKey = String(CHAT)) {
  const taken: string[] = [];
  const taker: TypedAnswerTaker = {
    sessionKey,
    chatId: CHAT,
    messageId,
    take: async (_ctx, text) => {
      if (accept) taken.push(text);
      return accept;
    },
  };
  return { taken, stop: acceptTypedAnswers(taker) };
}

/** Run a text message through the middleware; true when it went on. */
async function send(text: string, replyTo?: { id: number; isBot?: boolean }): Promise<boolean> {
  const ctx = {
    chat: { id: CHAT, type: 'private' },
    from: { id: CHAT },
    message: {
      message_id: 900,
      chat: { id: CHAT },
      text,
      ...(replyTo ? { reply_to_message: { message_id: replyTo.id, from: { id: 1, is_bot: replyTo.isBot ?? true } } } : {}),
    },
  } as unknown as Context;
  let passed = false;
  await captureTypedAnswers(ctx, async () => {
    passed = true;
  });
  return passed;
}

describe('captureTypedAnswers', () => {
  it('lets a message through when no question is open', async () => {
    expect(await send('hello')).toBe(true);
  });

  it('hands a message to the open question and keeps it from going on', async () => {
    const q = openQuestion(10);
    expect(await send('neither, use C')).toBe(false);
    expect(q.taken).toEqual(['neither, use C']);
  });

  it('lets commands through, so /cancel still works', async () => {
    const q = openQuestion(10);
    expect(await send('/cancel')).toBe(true);
    expect(q.taken).toEqual([]);
  });

  it('gives a reply to the question it replies to, and anything else to the one asked last', async () => {
    const first = openQuestion(10);
    const second = openQuestion(11);
    await send('for the first', { id: 10 });
    await send('no reply');
    expect(first.taken).toEqual(['for the first']);
    expect(second.taken).toEqual(['no reply']);
  });

  it('lets the message go on when the question could not take it', async () => {
    openQuestion(10, false);
    expect(await send('too late')).toBe(true);
  });

  it('leaves an answer to a ForceReply prompt to the flow that asked', async () => {
    const q = openQuestion(10);
    rememberForceReplyPrompt(CHAT, 77, 'project');
    expect(await send('api', { id: 77 })).toBe(true);
    expect(q.taken).toEqual([]);
  });

  it('ignores questions open in another thread', async () => {
    const q = openQuestion(10, true, `${CHAT}:5`);
    expect(await send('hello')).toBe(true);
    expect(q.taken).toEqual([]);
  });
});

describe('closing a question to typed answers', () => {
  it('stops with the call acceptTypedAnswers returned', async () => {
    const q = openQuestion(10);
    q.stop();
    q.stop();
    expect(await send('hello')).toBe(true);
    expect(isOpenQuestionMessage(CHAT, 10)).toBe(false);
  });

  it('stops every question in a session, as /cancel does, and leaves other sessions alone', () => {
    openQuestion(10);
    openQuestion(11);
    openQuestion(12, true, `${CHAT}:5`);
    stopTypedAnswers(String(CHAT));
    expect(pickTaker(String(CHAT))).toBeUndefined();
    expect(pickTaker(`${CHAT}:5`)?.messageId).toBe(12);
  });
});

describe('shownTypedAnswer', () => {
  it('puts the answer on one line and clips a long one', () => {
    expect(shownTypedAnswer('  use\n the   cache ')).toBe('✏️ use the cache');
    const shown = shownTypedAnswer('x'.repeat(500));
    expect(shown.length).toBeLessThan(210);
    expect(shown.endsWith('…')).toBe(true);
  });
});

describe('the reaction', () => {
  it('never throws when the chat refuses reactions', async () => {
    const { acknowledgeTypedAnswer } = await import('../../src/claude/typed-answer.js');
    const ctx = { react: vi.fn().mockRejectedValue(new Error('REACTION_INVALID')) } as unknown as Context;
    await expect(acknowledgeTypedAnswer(ctx)).resolves.toBeUndefined();
    expect(ctx.react).toHaveBeenCalledWith('👌');
  });
});
