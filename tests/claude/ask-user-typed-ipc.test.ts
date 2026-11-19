/**
 * A single telecoder_ask_user question answered in the user's own words, and
 * one claude stopped waiting on, driven through the real IPC server and
 * ask_user handler with a stand-in for Telegram.
 */

import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import * as http from 'http';
import type { Context } from 'grammy';

vi.mock('../../src/claude/monitor-relay.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/claude/monitor-relay.js')>()),
  settleBeforePost: vi.fn(),
}));
vi.mock('../../src/telegram/message-sender.js', () => ({
  messageSender: {
    sendMessage: async () => 1,
    noteQuestionPosted: async () => {},
    noteQuestionAnswered: async () => {},
  },
}));

const { startIpcServer, getIpcPort, getIpcToken, registerSessionChat, unregisterSessionChat } =
  await import('../../src/claude/ipc-server.js');
await import('../../src/claude/mcp-bridge.js');
const { hasPendingQuestionForSession } = await import('../../src/claude/ask-user.js');
const { captureTypedAnswers, isOpenQuestionMessage, _resetTypedAnswersForTests } =
  await import('../../src/claude/typed-answer.js');

const CHAT = 300;
const QUESTION_MSG = 9;

/** Ask a question over IPC. `hangUp` drops the call the way claude cancelling it does. */
function ask(): { answer: Promise<Record<string, unknown>>; hangUp: () => void } {
  const data = JSON.stringify({
    session_id: 's3',
    question: 'Which cache?',
    context: 'Both are wired up.',
    options: [{ label: 'Redis' }, { label: 'In memory' }],
  });
  let req!: http.ClientRequest;
  const answer = new Promise<Record<string, unknown>>((resolve, reject) => {
    req = http.request({
      host: '127.0.0.1',
      port: getIpcPort(),
      path: '/mcp/ask_user',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), 'X-TeleCoder-Token': getIpcToken() },
    }, (res) => {
      let text = '';
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => resolve(JSON.parse(text)));
    });
    req.on('error', reject);
    req.end(data);
  });
  return { answer, hangUp: () => req.destroy() };
}

function fakeApi() {
  return {
    sendMessage: vi.fn(async () => ({ message_id: QUESTION_MSG, chat: { id: CHAT } })),
    editMessageText: vi.fn(async () => true),
    editMessageReplyMarkup: vi.fn(async () => true),
  };
}

/** The user sends `text` in the chat; true when it went on past the capture. */
async function userSends(text: string) {
  const ctx = {
    chat: { id: CHAT, type: 'private' },
    from: { id: CHAT },
    message: { message_id: 50, chat: { id: CHAT }, text },
    react: vi.fn(async () => true),
  };
  let passed = false;
  await captureTypedAnswers(ctx as unknown as Context, async () => {
    passed = true;
  });
  return { passed, react: ctx.react };
}

beforeAll(async () => {
  await startIpcServer();
});

afterEach(() => {
  unregisterSessionChat('s3');
  _resetTypedAnswersForTests();
});

describe('a question answered in the user\'s own words', () => {
  it('returns the text to claude, marked as typed, and closes the question with it', async () => {
    const api = fakeApi();
    registerSessionChat('s3', String(CHAT), { chat: { id: CHAT }, api });

    const { answer } = ask();
    await vi.waitFor(() => expect(isOpenQuestionMessage(CHAT, QUESTION_MSG)).toBe(true));
    expect((api.sendMessage.mock.lastCall as unknown as [number, string])[1]).toContain('✏️ Or reply with your own answer.');

    const sent = await userSends('neither, skip the cache');
    expect(sent.passed).toBe(false);
    expect(sent.react).toHaveBeenCalledWith('👌');
    expect(await answer).toEqual({ success: true, message: 'User answered in their own words: neither, skip the cache' });

    const [chatId, messageId, text] = api.editMessageText.mock.lastCall as unknown as [number, number, string];
    expect([chatId, messageId]).toEqual([CHAT, QUESTION_MSG]);
    expect(text).toMatch(/✅ Answered: ✏️ neither, skip the cache$/);
    expect((await userSends('next prompt')).passed).toBe(true);
  });
});

describe('a question claude stops waiting on', () => {
  it('closes, and the next message is an ordinary one again', async () => {
    const api = fakeApi();
    registerSessionChat('s3', String(CHAT), { chat: { id: CHAT }, api });

    const { answer, hangUp } = ask();
    answer.catch(() => {});
    await vi.waitFor(() => expect(isOpenQuestionMessage(CHAT, QUESTION_MSG)).toBe(true));
    hangUp();

    await vi.waitFor(() => expect(api.editMessageText).toHaveBeenCalled());
    expect((api.editMessageText.mock.lastCall as unknown as [number, number, string])[2])
      .toMatch(/🚫 Claude stopped waiting for an answer\.$/);
    expect(isOpenQuestionMessage(CHAT, QUESTION_MSG)).toBe(false);
    expect(hasPendingQuestionForSession(String(CHAT))).toBe(false);
    expect((await userSends('a new prompt')).passed).toBe(true);
  });
});
