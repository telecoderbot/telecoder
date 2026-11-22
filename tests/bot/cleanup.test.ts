/**
 * /cleanup offers the idle threads of a private chat as a list to tick, and
 * deletes the ticked ones; /keep keeps a thread off that list. The chat
 * history, the busy signals, Haiku and the delete itself are stubbed, so these
 * tests see which threads are offered, which start ticked, and which go.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Context } from 'grammy';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 10, 22, 12);

interface Entry { topic?: string; projectName: string; lastActivity: string; lastMessagePreview: string; lastAssistantPreview?: string }
const history = new Map<string, Entry>();
vi.mock('../../src/claude/session-history.js', () => ({
  sessionHistory: {
    getAllActiveSessions: () => new Map(history),
    getLastSession: (key: string) => history.get(key),
  },
}));
const pendingWork = vi.fn((_key: string): string | undefined => undefined);
vi.mock('../../src/bot/middleware/queued-messages.js', () => ({ pendingWork }));
const hasRunningTasks = vi.fn((_key: string) => false);
vi.mock('../../src/telegram/background-activity-card.js', () => ({ hasRunningTasks }));
const listSchedules = vi.fn((_key: string): Array<{ disabled: boolean }> => []);
vi.mock('../../src/claude/scheduler.js', () => ({ scheduler: { listSchedules } }));
const judgeThreads = vi.fn();
vi.mock('../../src/claude/thread-judge-haiku.js', () => ({ judgeThreads }));
const deleteThread = vi.fn(async (_api: unknown, _key: string, _why?: string): Promise<string | null> => null);
vi.mock('../../src/bot/handlers/command/thread.js', () => ({ deleteThread }));
const forgotten = new Set<string>();
vi.mock('../../src/bot/deleted-threads.js', () => ({ isThreadForgotten: (key: string) => forgotten.has(key) }));
vi.mock('../../src/telegram/thread-titles.js', () => ({
  hasImplicitName: () => false,
  threadDisplayName: () => undefined,
  threadName: (topic: string, _prefix: string, project: string) => [project, topic].filter(Boolean).join(' · '),
}));

const cleanup = await import('../../src/bot/handlers/command/cleanup.js');
const { setThreadKept, resetKeptThreadsForTest } = await import('../../src/bot/kept-threads.js');

const CHAT = 37620077;
const HERE = 1;
const keyOf = (thread: number) => `${CHAT}:${thread}`;

function thread(id: number, idleDays: number, topic = `topic ${id}`, chat = CHAT): void {
  history.set(`${chat}:${id}`, {
    topic,
    projectName: 'proj',
    lastActivity: new Date(NOW - idleDays * DAY).toISOString(),
    lastMessagePreview: `asked ${id}`,
    lastAssistantPreview: `answered ${id}`,
  });
}

function command(text: string, type = 'private') {
  return {
    chat: { id: CHAT, type },
    message: { text, is_topic_message: true, message_thread_id: HERE },
    reply: vi.fn(async (_text: string, _other?: unknown) => ({ message_id: 500 })),
    api: { editMessageText: vi.fn(async (..._args: unknown[]) => true) },
  };
}

function tap(data: string) {
  return {
    chat: { id: CHAT, type: 'private' },
    callbackQuery: { data, message: { message_id: 500, chat: { id: CHAT }, is_topic_message: true, message_thread_id: HERE } },
    answerCallbackQuery: vi.fn(async () => true),
    editMessageReplyMarkup: vi.fn(async () => true),
    api: { editMessageText: vi.fn(async (..._args: unknown[]) => true) },
  };
}

const asCtx = (c: unknown) => c as Context;

/** The thread buttons of the list last edited onto the status message. */
function buttonsOf(edit: ReturnType<typeof vi.fn>): string[] {
  const other = edit.mock.calls.at(-1)![3] as { reply_markup: { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> } };
  return other.reply_markup.inline_keyboard.flat().map((b) => b.text);
}
function callbackOf(edit: ReturnType<typeof vi.fn>, label: string): string {
  const other = edit.mock.calls.at(-1)![3] as { reply_markup: { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> } };
  return other.reply_markup.inline_keyboard.flat().find((b) => b.text.startsWith(label))!.callback_data;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  history.clear();
  forgotten.clear();
  resetKeptThreadsForTest();
  cleanup.resetCleanupViewsForTest();
  judgeThreads.mockImplementation(async (threads: unknown[]) => threads.map(() => 'done'));
});

describe('parseMinIdle', () => {
  it('reads hours, days and weeks, and 0 for no threshold', () => {
    expect(cleanup.parseMinIdle('')).toBe(2 * DAY);
    expect(cleanup.parseMinIdle('12h')).toBe(DAY / 2);
    expect(cleanup.parseMinIdle('7d')).toBe(7 * DAY);
    expect(cleanup.parseMinIdle('2w')).toBe(14 * DAY);
    expect(cleanup.parseMinIdle('0')).toBe(0);
    expect(cleanup.parseMinIdle('soon')).toBeUndefined();
  });
});

describe('surveyThreads', () => {
  it("offers this chat's idle threads, idle longest first", () => {
    thread(10, 3);
    thread(11, 20);
    thread(12, 5, 'other chat', 999);
    history.set(String(CHAT), { projectName: 'proj', lastActivity: new Date(NOW - 30 * DAY).toISOString(), lastMessagePreview: '' });

    const { rows } = cleanup.surveyThreads(CHAT, keyOf(HERE), 2 * DAY, NOW);

    expect(rows.map((r) => r.sessionKey)).toEqual([keyOf(11), keyOf(10)]);
  });

  it('leaves alone this thread, kept ones, busy ones and recent ones', () => {
    thread(HERE, 9);
    thread(20, 9);
    setThreadKept(keyOf(20), true);
    thread(21, 9);
    pendingWork.mockImplementation((key) => (key === keyOf(21) ? 'working' : undefined));
    thread(22, 9);
    hasRunningTasks.mockImplementation((key) => key === keyOf(22));
    thread(23, 9);
    listSchedules.mockImplementation((key) => (key === keyOf(23) ? [{ disabled: false }] : []));
    thread(24, 0.5);
    thread(25, 9);

    const { rows, skipped } = cleanup.surveyThreads(CHAT, keyOf(HERE), 2 * DAY, NOW);

    expect(rows.map((r) => r.sessionKey)).toEqual([keyOf(25)]);
    expect(skipped.map((s) => s.reason).sort()).toEqual(
      ['active 12h ago', 'background task running', 'has a schedule', 'kept', 'this thread', 'working'].sort(),
    );
  });

  it('never offers a thread already deleted', () => {
    thread(30, 9);
    forgotten.add(keyOf(30));

    expect(cleanup.surveyThreads(CHAT, keyOf(HERE), 0, NOW).rows).toEqual([]);
  });
});

describe('/cleanup', () => {
  it('ticks the threads Haiku found done and leaves the ones with loose ends unticked', async () => {
    thread(40, 9, 'finished');
    thread(41, 5, 'half done');
    judgeThreads.mockImplementation(async () => ['done', 'open']);
    const ctx = command('/cleanup');

    await cleanup.handleCleanup(asCtx(ctx));

    expect(judgeThreads).toHaveBeenCalledWith([
      expect.objectContaining({ topic: 'finished', lastUserMessage: 'asked 40', lastReply: 'answered 40' }),
      expect.objectContaining({ topic: 'half done' }),
    ]);
    const buttons = buttonsOf(ctx.api.editMessageText);
    expect(buttons).toContain('☑️ proj · finished · 9d');
    expect(buttons).toContain('⬜ ⚠️ proj · half done · 5d');
    expect(buttons).toContain('🗑️ Delete 1');
  });

  it('ticks everything and says so when Haiku gives no answer', async () => {
    thread(40, 9);
    judgeThreads.mockImplementation(async () => undefined);
    const ctx = command('/cleanup');

    await cleanup.handleCleanup(asCtx(ctx));

    expect(buttonsOf(ctx.api.editMessageText)).toContain('🗑️ Delete 1');
    expect(ctx.api.editMessageText.mock.calls.at(-1)![2]).toContain('couldn\'t check these for loose ends');
  });

  it('says there is nothing to clean up without asking Haiku', async () => {
    thread(40, 0.5);
    const ctx = command('/cleanup');

    await cleanup.handleCleanup(asCtx(ctx));

    expect(judgeThreads).not.toHaveBeenCalled();
    expect(ctx.reply.mock.calls[0]![0]).toContain('No threads idle for 2d or more');
  });

  it('works only in private chats', async () => {
    const ctx = command('/cleanup', 'supergroup');

    await cleanup.handleCleanup(asCtx(ctx));

    expect(ctx.reply.mock.calls[0]![0]).toContain('works in private chats');
    expect(judgeThreads).not.toHaveBeenCalled();
  });

  it('explains an argument it cannot read', async () => {
    const ctx = command('/cleanup soon');

    await cleanup.handleCleanup(asCtx(ctx));

    expect(ctx.reply.mock.calls[0]![0]).toContain('Usage');
  });
});

describe('the buttons', () => {
  async function listOf(...threads: Array<[number, number]>) {
    for (const [id, idle] of threads) thread(id, idle);
    const ctx = command('/cleanup');
    await cleanup.handleCleanup(asCtx(ctx));
    return ctx.api.editMessageText;
  }

  it('deletes only the ticked threads', async () => {
    const edit = await listOf([50, 9], [51, 8]);

    const untick = tap(callbackOf(edit, '☑️ proj · topic 51'));
    await cleanup.handleCleanupCallback(asCtx(untick));
    expect(buttonsOf(untick.api.editMessageText)).toContain('⬜ proj · topic 51 · 8d');

    const go = tap(callbackOf(untick.api.editMessageText, '🗑️ Delete 1'));
    await cleanup.handleCleanupCallback(asCtx(go));

    expect(deleteThread).toHaveBeenCalledTimes(1);
    expect(deleteThread).toHaveBeenCalledWith(go.api, keyOf(50), '/cleanup');
    expect(go.api.editMessageText.mock.calls.at(-1)![2]).toContain('Deleted 1 thread');
  });

  it('keeps a thread that came back to life after the list went up', async () => {
    const edit = await listOf([60, 9], [61, 8], [62, 7]);
    const goData = callbackOf(edit, '🗑️ Delete 3');

    setThreadKept(keyOf(60), true);
    thread(61, 0); // used again
    await cleanup.handleCleanupCallback(asCtx(tap(goData)));

    expect(deleteThread.mock.calls.map((c) => c[1])).toEqual([keyOf(62)]);
  });

  it('runs once, however often Delete is tapped', async () => {
    const edit = await listOf([70, 9]);
    const goData = callbackOf(edit, '🗑️ Delete 1');

    await cleanup.handleCleanupCallback(asCtx(tap(goData)));
    const again = tap(goData);
    await cleanup.handleCleanupCallback(asCtx(again));

    expect(deleteThread).toHaveBeenCalledTimes(1);
    expect(again.answerCallbackQuery).toHaveBeenCalledWith({ text: expect.stringContaining('expired') });
  });

  it('reports a thread Telegram would not delete', async () => {
    deleteThread.mockResolvedValueOnce('Bad Request: not enough rights');
    const edit = await listOf([80, 9]);

    const go = tap(callbackOf(edit, '🗑️ Delete 1'));
    await cleanup.handleCleanupCallback(asCtx(go));

    expect(go.api.editMessageText.mock.calls.at(-1)![2]).toContain('not enough rights');
  });

  it('deletes nothing on Cancel', async () => {
    const edit = await listOf([90, 9]);

    await cleanup.handleCleanupCallback(asCtx(tap(callbackOf(edit, '✗ Cancel'))));

    expect(deleteThread).not.toHaveBeenCalled();
  });
});
