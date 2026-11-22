/**
 * /cleanup: delete the threads of a private chat that are done with, in one go.
 *
 * Telegram can't list a chat's threads to a bot, but the chat history has one
 * entry per thread the bot has had a session in, with when it was last used.
 * That's the list. A thread is left alone when deleting it could lose
 * something: the thread /cleanup is sent in, a kept one (/keep), one with a
 * turn running, messages waiting or one set aside, a background task, a
 * schedule, or one used more recently than the idle threshold (2 days, or
 * what `/cleanup 7d` says).
 *
 * The rest are offered as a list of buttons to tick, and Haiku reads the end of
 * each to guess which still have loose ends: those start unticked, marked ⚠️.
 * Nothing goes until the Delete tap, and every thread is checked again then,
 * since one may have come back to life in the meantime. Each is deleted the
 * way /deletethread does it; the transcripts stay on disk for /resume.
 *
 * Private chats only: a group's topics are everyone's, and go one at a time.
 */

import { randomBytes } from 'crypto';
import type { Api, Context } from 'grammy';
import type { InlineKeyboardButton } from 'grammy/types';
import { sessionHistory, type SessionHistoryEntry } from '../../../claude/session-history.js';
import { scheduler } from '../../../claude/scheduler.js';
import { judgeThreads, type ThreadSummary, type ThreadVerdict } from '../../../claude/thread-judge-haiku.js';
import { hasRunningTasks } from '../../../telegram/background-activity-card.js';
import { EntityText, type EntityMessage } from '../../../telegram/entities.js';
import { cutLabel } from '../../../telegram/prompt-label.js';
import { editCallbackMessage, editFormatted, replyFormatted } from '../../../telegram/send.js';
import { hasImplicitName, threadDisplayName, threadName } from '../../../telegram/thread-titles.js';
import { getSessionKeyFromCtx, parseSessionKey } from '../../../utils/session-key.js';
import { sanitizeError } from '../../../utils/sanitize.js';
import { isThreadForgotten } from '../../deleted-threads.js';
import { isThreadKept } from '../../kept-threads.js';
import { pendingWork } from '../../middleware/queued-messages.js';
import { deleteThread } from './thread.js';
import { parseCallback } from './shared.js';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
export const DEFAULT_MIN_IDLE_MS = 2 * DAY_MS;
/** Thread buttons in one list; Telegram takes 100 buttons, and a phone screen far fewer. */
export const MAX_ROWS = 40;
/** Lines of "left alone" before the rest are only counted. */
const MAX_SKIPPED_LINES = 15;
const MAX_LABEL_CHARS = 30;
/** How long a list's buttons keep working. */
const VIEW_TTL_MS = HOUR_MS;

const UNITS: Record<string, number> = { h: HOUR_MS, d: DAY_MS, w: 7 * DAY_MS };

/** The idle threshold an argument asks for: undefined for one that isn't one. */
export function parseMinIdle(arg: string): number | undefined {
  const a = arg.trim().toLowerCase();
  if (a === '') return DEFAULT_MIN_IDLE_MS;
  if (a === '0' || a === 'any' || a === 'all') return 0;
  const m = /^(\d+)\s*([hdw])$/.exec(a);
  return m ? Number(m[1]) * UNITS[m[2]!]! : undefined;
}

/** A span the short way: 45m, 5h, 3d, 2w. */
export function formatSpan(ms: number): string {
  if (ms < HOUR_MS) return `${Math.max(1, Math.floor(ms / 60000))}m`;
  if (ms < DAY_MS) return `${Math.floor(ms / HOUR_MS)}h`;
  if (ms < 14 * DAY_MS) return `${Math.floor(ms / DAY_MS)}d`;
  return `${Math.floor(ms / (7 * DAY_MS))}w`;
}

export interface ThreadRow {
  sessionKey: string;
  name: string;
  idleMs: number;
  /** As the chat history had it when the list went up. */
  lastActivity: string;
  summary: ThreadSummary;
  verdict?: ThreadVerdict;
}

export interface SkippedThread {
  name: string;
  reason: string;
}

function nameOf(sessionKey: string, entry: SessionHistoryEntry): string {
  const shown = hasImplicitName(sessionKey) ? undefined : threadDisplayName(sessionKey);
  return shown || threadName(entry.topic ?? '', '', entry.projectName) || entry.projectName;
}

/** Why deleting this thread now could lose something, apart from how recently it was used. */
export function busyReason(sessionKey: string): string | undefined {
  if (isThreadKept(sessionKey)) return 'kept';
  const work = pendingWork(sessionKey);
  if (work) return work;
  if (hasRunningTasks(sessionKey)) return 'background task running';
  if (scheduler.listSchedules(sessionKey).some((s) => !s.disabled)) return 'has a schedule';
  return undefined;
}

/** This chat's threads, split into the ones to offer (idle longest first) and the ones left alone. */
export function surveyThreads(
  chatId: number,
  currentKey: string,
  minIdleMs: number,
  now = Date.now(),
): { rows: ThreadRow[]; skipped: SkippedThread[] } {
  const rows: ThreadRow[] = [];
  const skipped: SkippedThread[] = [];
  for (const [sessionKey, entry] of sessionHistory.getAllActiveSessions()) {
    const key = parseSessionKey(sessionKey);
    if (key.chatId !== chatId || key.threadId === undefined || isThreadForgotten(sessionKey)) continue;
    const name = nameOf(sessionKey, entry);
    const idleMs = now - new Date(entry.lastActivity).getTime();
    const reason = sessionKey === currentKey ? 'this thread'
      : busyReason(sessionKey) ?? (idleMs < minIdleMs ? `active ${formatSpan(idleMs)} ago` : undefined);
    if (reason) {
      skipped.push({ name, reason });
      continue;
    }
    rows.push({
      sessionKey,
      name,
      idleMs,
      lastActivity: entry.lastActivity,
      summary: { topic: entry.topic, lastUserMessage: entry.lastMessagePreview, lastReply: entry.lastAssistantPreview },
    });
  }
  rows.sort((a, b) => b.idleMs - a.idleMs);
  return { rows, skipped };
}

// ── The list ─────────────────────────────────────────────────────────────

export interface CleanupView {
  id: string;
  chatId: number;
  minIdleMs: number;
  rows: ThreadRow[];
  ticked: Set<number>;
  skipped: SkippedThread[];
  /** Offerable threads past MAX_ROWS, for the next /cleanup. */
  more: number;
  /** Whether Haiku gave verdicts, couldn't, or wasn't asked (no threads). */
  judged: 'yes' | 'failed' | 'no';
  expiresAt: number;
}

const views = new Map<string, CleanupView>();

function pruneViews(now: number): void {
  for (const [id, view] of views) if (view.expiresAt <= now) views.delete(id);
}

/** A thread starts ticked unless Haiku saw loose ends in it. */
export function buildView(
  chatId: number,
  minIdleMs: number,
  survey: { rows: ThreadRow[]; skipped: SkippedThread[] },
  verdicts: Array<ThreadVerdict | undefined> | undefined,
  now = Date.now(),
): CleanupView {
  const rows = survey.rows.slice(0, MAX_ROWS).map((row, i) => ({ ...row, verdict: verdicts?.[i] }));
  return {
    id: randomBytes(4).toString('hex'),
    chatId,
    minIdleMs,
    rows,
    ticked: new Set(rows.flatMap((row, i) => (row.verdict === 'open' ? [] : [i]))),
    skipped: survey.skipped,
    more: Math.max(0, survey.rows.length - MAX_ROWS),
    judged: rows.length === 0 ? 'no' : verdicts ? 'yes' : 'failed',
    expiresAt: now + VIEW_TTL_MS,
  };
}

function addSkipped(text: EntityText, skipped: SkippedThread[]): void {
  if (skipped.length === 0) return;
  text.newline(2).bold(`Left alone (${skipped.length}):`);
  for (const s of skipped.slice(0, MAX_SKIPPED_LINES)) {
    text.newline().add(`${s.reason === 'kept' ? '📌' : '•'} ${cutLabel(s.name, 48)}: `).italic(s.reason);
  }
  if (skipped.length > MAX_SKIPPED_LINES) text.newline().italic(`…and ${skipped.length - MAX_SKIPPED_LINES} more`);
}

export function renderView(view: CleanupView): { text: EntityMessage; keyboard: InlineKeyboardButton[][] } {
  const text = new EntityText().add('🧹 ').bold('Clean up threads');

  if (view.rows.length === 0) {
    text.newline(2).add(view.minIdleMs > 0
      ? `No threads idle for ${formatSpan(view.minIdleMs)} or more to clean up.`
      : 'No threads to clean up.');
    addSkipped(text, view.skipped);
    if (view.minIdleMs > 0 && view.skipped.some((s) => s.reason.startsWith('active '))) {
      text.newline(2).add('💡 ').code('/cleanup 12h').add(' offers threads idle for less long.');
    }
    return { text: text.build(), keyboard: [] };
  }

  text.newline(2).add('Delete the ticked threads? ')
    .add('Telegram can\'t undo this, but the conversations stay on disk, so ').code('/resume').add(' can still pick them up.');
  if (view.judged === 'failed') {
    text.newline(2).add('⚠️ Haiku couldn\'t check these for loose ends, so look them over.');
  } else if (view.rows.some((r) => r.verdict === 'open')) {
    text.newline(2).add('⚠️ marks a thread where Haiku saw loose ends. Those start unticked.');
  }
  if (view.more > 0) {
    text.newline(2).italic(`Showing the ${view.rows.length} idle longest. ${view.more} more after these: send /cleanup again.`);
  }
  addSkipped(text, view.skipped);
  text.newline(2).add('💡 ').code('/keep').add(' in a thread keeps it out of cleanups.');

  const keyboard: InlineKeyboardButton[][] = view.rows.map((row, i) => [{
    text: `${view.ticked.has(i) ? '☑️' : '⬜'} ${row.verdict === 'open' ? '⚠️ ' : ''}${cutLabel(row.name, MAX_LABEL_CHARS)} · ${formatSpan(row.idleMs)}`,
    callback_data: `cleanup:${view.id}:t:${i}`,
  }]);
  if (view.rows.length > 1) {
    keyboard.push([
      { text: '☑️ All', callback_data: `cleanup:${view.id}:all` },
      { text: '⬜ None', callback_data: `cleanup:${view.id}:none` },
    ]);
  }
  const count = view.ticked.size;
  keyboard.push([
    ...(count > 0 ? [{ text: `🗑️ Delete ${count}`, callback_data: `cleanup:${view.id}:go` }] : []),
    { text: '✗ Cancel', callback_data: `cleanup:${view.id}:x` },
  ]);
  return { text: text.build(), keyboard };
}

// ── /cleanup ─────────────────────────────────────────────────────────────

export async function handleCleanup(ctx: Context): Promise<void> {
  const keyInfo = getSessionKeyFromCtx(ctx);
  if (!keyInfo) return;
  const { chatId, sessionKey } = keyInfo;

  if (ctx.chat?.type !== 'private') {
    await replyFormatted(ctx, new EntityText()
      .add('🧹 ').code('/cleanup').add(' works in private chats, where every thread is yours. ')
      .add('In a group, delete topics one at a time with ').code('/deletethread').add('.').build());
    return;
  }

  const arg = (ctx.message?.text ?? '').split(' ').slice(1).join(' ');
  const minIdleMs = parseMinIdle(arg);
  if (minIdleMs === undefined) {
    await replyFormatted(ctx, new EntityText()
      .add('ℹ️ Usage: ').code('/cleanup').add(' offers threads idle for 2 days or more; ')
      .code('/cleanup 12h').add(', ').code('/cleanup 7d').add(' or ').code('/cleanup 2w').add(' set the idle time, and ')
      .code('/cleanup 0').add(' offers every idle thread.').build());
    return;
  }

  const now = Date.now();
  pruneViews(now);
  const survey = surveyThreads(chatId, sessionKey, minIdleMs, now);
  if (survey.rows.length === 0) {
    await replyFormatted(ctx, renderView(buildView(chatId, minIdleMs, survey, undefined, now)).text);
    return;
  }

  const shown = Math.min(survey.rows.length, MAX_ROWS);
  const status = await ctx.reply(`🧹 Looking through ${shown} idle thread${shown === 1 ? '' : 's'} for loose ends…`);
  const verdicts = await judgeThreads(survey.rows.slice(0, MAX_ROWS).map((r) => r.summary));
  const view = buildView(chatId, minIdleMs, survey, verdicts);
  views.set(view.id, view);
  const { text, keyboard } = renderView(view);
  await editFormatted(ctx.api, chatId, status.message_id, text, { reply_markup: { inline_keyboard: keyboard } });
}

// ── The buttons ──────────────────────────────────────────────────────────

/** Delete what's ticked, checking each thread again first. The report. */
export async function deleteTicked(api: Api, view: CleanupView): Promise<EntityMessage> {
  const deleted: string[] = [];
  const kept: SkippedThread[] = [];
  const failed: SkippedThread[] = [];

  for (const i of [...view.ticked].sort((a, b) => a - b)) {
    const row = view.rows[i];
    if (!row) continue;
    // Deleted some other way since the list went up.
    if (isThreadForgotten(row.sessionKey)) {
      deleted.push(row.name);
      continue;
    }
    // Used again since then, which moves its history entry on.
    const entry = sessionHistory.getLastSession(row.sessionKey);
    const usedSince = entry !== undefined && entry.lastActivity > row.lastActivity;
    const reason = busyReason(row.sessionKey) ?? (usedSince ? 'used since the list went up' : undefined);
    if (reason) {
      kept.push({ name: row.name, reason });
      continue;
    }
    try {
      const error = await deleteThread(api, row.sessionKey, '/cleanup');
      if (error) failed.push({ name: row.name, reason: error });
      else deleted.push(row.name);
    } catch (err) {
      failed.push({ name: row.name, reason: sanitizeError(err) });
    }
  }

  const text = new EntityText().add('🧹 ');
  text.bold(deleted.length === 0 ? 'No threads deleted' : `Deleted ${deleted.length} thread${deleted.length === 1 ? '' : 's'}`);
  for (const name of deleted.slice(0, MAX_ROWS)) text.newline().add(`• ${cutLabel(name, 48)}`);
  if (kept.length > 0) {
    text.newline(2).bold('Kept, since they changed:');
    for (const s of kept) text.newline().add(`• ${cutLabel(s.name, 48)}: `).italic(s.reason);
  }
  if (failed.length > 0) {
    text.newline(2).bold('Couldn\'t delete:');
    for (const s of failed) text.newline().add(`• ${cutLabel(s.name, 48)}: `).italic(s.reason);
  }
  if (deleted.length > 0) {
    text.newline(2).add('The conversations stay on disk: ').code('/resume').add(' picks any of them up again.');
  }
  return text.build();
}

export async function handleCleanupCallback(ctx: Context): Promise<void> {
  const cb = parseCallback(ctx, 'cleanup:');
  if (!cb) return;
  const m = /^cleanup:([0-9a-f]+):(t|all|none|go|x)(?::(\d+))?$/.exec(cb.data);
  const view = m ? views.get(m[1]!) : undefined;
  if (!m || !view || view.chatId !== cb.chatId || view.expiresAt <= Date.now()) {
    await ctx.answerCallbackQuery({ text: 'This list has expired. Send /cleanup again.' }).catch(() => {});
    await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [] } }).catch(() => {});
    return;
  }

  const action = m[2]!;
  if (action === 'x') {
    views.delete(view.id);
    await ctx.answerCallbackQuery({ text: 'Nothing deleted.' }).catch(() => {});
    await editCallbackMessage(ctx, new EntityText().add('👍 Nothing deleted.').build()).catch(() => {});
    return;
  }

  if (action === 'go') {
    // Gone before the first delete, so a second tap can't start a second run.
    views.delete(view.id);
    await ctx.answerCallbackQuery({ text: 'Deleting…' }).catch(() => {});
    await editCallbackMessage(ctx, `🧹 Deleting ${view.ticked.size} thread${view.ticked.size === 1 ? '' : 's'}…`).catch(() => {});
    const report = await deleteTicked(ctx.api, view);
    await editCallbackMessage(ctx, report).catch((err: unknown) => {
      console.error('[Cleanup] Could not post the report:', sanitizeError(err));
    });
    return;
  }

  if (action === 't') {
    const i = Number(m[3]);
    if (i >= 0 && i < view.rows.length) {
      if (view.ticked.has(i)) view.ticked.delete(i);
      else view.ticked.add(i);
    }
  } else if (action === 'all') {
    view.ticked = new Set(view.rows.map((_, i) => i));
  } else {
    view.ticked = new Set();
  }
  await ctx.answerCallbackQuery().catch(() => {});
  const { text, keyboard } = renderView(view);
  await editCallbackMessage(ctx, text, { reply_markup: { inline_keyboard: keyboard } }).catch(() => {});
}

/** Test seam: forget every open list. */
export function resetCleanupViewsForTest(): void {
  views.clear();
}

/** Test seam: an open list, by id. */
export function cleanupViewForTest(id: string): CleanupView | undefined {
  return views.get(id);
}
