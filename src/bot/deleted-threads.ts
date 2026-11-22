/**
 * Letting go of a thread that no longer exists.
 *
 * Telegram tells a bot nothing when a thread is deleted: no update, no service
 * message. Left alone, the thread's session lives on — its PTY claude running
 * until the next restart, a turn still working, renames and replies sent into
 * the void. So the bot notices for itself, two ways:
 *
 * - /deletethread deletes the thread and lets it go in the same step.
 * - Any send into a deleted thread fails, with "message thread not found" for
 *   a message and TOPIC_ID_INVALID for a topic call (tested 2026-11-14), and
 *   that failure is taken as the news.
 *
 * A thread deleted by hand while idle sends nothing, so neither sees it; the
 * PTY idle reaper (claude/pty-idle-reaper.ts) ends its claude instead.
 *
 * What's let go is what lives for the thread alone: its claude and turn, its
 * in-memory session, its name, its own settings and its keep mark. The
 * transcript stays on disk, so /resume in any chat can still pick the
 * conversation up, and so does the chat history entry /resume takes its
 * titles from. Which threads were let go is kept on disk, so /cleanup doesn't
 * offer a deleted thread again after a restart.
 */

import * as path from 'path';
import { z } from 'zod';
import type { Api, Bot } from 'grammy';
import { BOT_ID } from '../config.js';
import { sessionManager } from '../claude/session-manager.js';
import { clearConversation } from '../providers/provider-router.js';
import { userPreferences } from '../providers/user-preferences.js';
import { forgetThreadTitle } from '../telegram/thread-titles.js';
import { buildSessionKey, parseSessionKey } from '../utils/session-key.js';
import { sanitizeError } from '../utils/sanitize.js';
import { ensureStateDir, getStateDir, readJsonFile, writeJsonFile } from '../utils/json-store.js';
import { stopTurn } from './middleware/queued-messages.js';
import { forgetKeptThread } from './kept-threads.js';

const fileSchema = z.object({ threads: z.array(z.string()) });

function stateFile(): string {
  return path.join(getStateDir(), `deleted-threads-${BOT_ID}.json`);
}

/** Thread ids aren't reused, so a thread let go stays let go. Loaded on first use. */
let forgottenSet: Set<string> | undefined;

function forgotten(): Set<string> {
  forgottenSet ??= new Set(readJsonFile(stateFile(), fileSchema, 'DeletedThreads')?.threads ?? []);
  return forgottenSet;
}

function remember(sessionKey: string): void {
  forgotten().add(sessionKey);
  ensureStateDir(getStateDir(), 'DeletedThreads');
  writeJsonFile(stateFile(), { threads: [...forgotten()] }, 'DeletedThreads');
}

/** Whether this thread was deleted, by /deletethread, /cleanup or by hand as far as the bot noticed. */
export function isThreadForgotten(sessionKey: string): boolean {
  return forgotten().has(sessionKey);
}

/** Whether a failed Bot API call says the thread it was aimed at is gone. */
export function isThreadGoneError(description: string | undefined): boolean {
  return description !== undefined && /message thread not found|TOPIC_ID_INVALID|TOPIC_DELETED/i.test(description);
}

/**
 * Stop and forget everything a deleted thread had going. Safe to call more
 * than once, and from inside a send that failed: only the first call acts.
 * Returns whether this call did.
 */
export async function forgetThread(api: Api, sessionKey: string, why: string): Promise<boolean> {
  if (parseSessionKey(sessionKey).threadId === undefined || forgotten().has(sessionKey)) return false;
  // Before anything else, since stopping the turn can send into the thread again.
  remember(sessionKey);
  console.log(`[DeletedThreads] ${sessionKey} is gone (${why}), ending its session`);
  try {
    await stopTurn(api, sessionKey);
  } catch (err) {
    console.error(`[DeletedThreads] Stopping the turn in ${sessionKey} failed:`, sanitizeError(err));
  }
  clearConversation(sessionKey);
  sessionManager.clearSession(sessionKey);
  forgetThreadTitle(sessionKey);
  userPreferences.forgetThread(sessionKey);
  forgetKeptThread(sessionKey);
  return true;
}

/** Take a send that failed on a deleted thread as word that it's gone. Call once, at startup. */
export function watchForDeletedThreads(bot: Bot): void {
  bot.api.config.use(async (prev, method, payload, signal) => {
    const res = await prev(method, payload, signal);
    if (res.ok || !isThreadGoneError(res.description)) return res;
    const { chat_id: chatId, message_thread_id: threadId } = payload as { chat_id?: unknown; message_thread_id?: unknown };
    if (typeof chatId === 'number' && typeof threadId === 'number') {
      // Not awaited: the turn being stopped may be the very one waiting on this send.
      void forgetThread(bot.api, buildSessionKey(chatId, threadId), `${method}: ${res.description}`);
    }
    return res;
  });
}

/** Test seam: forget which threads were let go, on disk too. */
export function resetDeletedThreadsForTest(): void {
  forgottenSet = new Set();
  ensureStateDir(getStateDir(), 'DeletedThreads');
  writeJsonFile(stateFile(), { threads: [] }, 'DeletedThreads');
}
