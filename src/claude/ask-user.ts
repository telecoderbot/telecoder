/**
 * Pending-question registry for telecoder_ask_user MCP tool.
 *
 * When Claude calls telecoder_ask_user, the MCP tool body:
 *   1. Calls createPendingQuestion() → gets { id, promise }
 *   2. Sends a Telegram message with an inline keyboard whose buttons have
 *      callback_data = `q:<id>:<optionIndex>`
 *   3. Awaits the promise
 *
 * When the user taps a button, the bot's callback dispatcher routes to
 * resolvePendingQuestion(id, ...), which fulfils the awaited promise so the
 * agent loop continues with the user's choice.
 *
 * A question nobody answers times out after QUESTION_TIMEOUT_MINUTES (10 by
 * default): the agent receives a "user did not respond" result and moves on,
 * and the caller closes the message (closeExpiredQuestion) so its keyboard
 * doesn't outlive the wait.
 *
 * In-memory only — a restart forgets every open question without touching its
 * message. The first tap on one of those gets the expired answer, and the tap
 * handler takes the dead keyboard down then.
 */

import * as crypto from 'crypto';
import type { Api } from 'grammy';
import type { MessageEntity } from 'grammy/types';
import { config } from '../config.js';
import {
  type LetteredOption,
  buildLetteredKeyboard,
  letteredOptionLines,
} from '../telegram/lettered-options.js';
import { TYPED_ANSWER_HINT } from './typed-answer.js';

export interface AskUserAnswer {
  /** The label of the option the user selected, or the answer they typed. */
  label: string;
  /** Zero-based index into the options array; -1 for a typed answer. */
  index: number;
  /** The user typed this answer rather than tapping an option (see typed-answer.ts). */
  typed?: true;
}

/**
 * Max characters of `context` we render into the question message. Keeps the
 * whole message comfortably under Telegram's 4096-char limit even alongside a
 * long question and eight annotated options; overflow is clipped with an
 * ellipsis rather than letting sendMessage 400 on us.
 */
const MAX_CONTEXT_LEN = 3500;

/** Telegram's hard cap on a text message / message edit. */
const MAX_MESSAGE_LEN = 4096;

/**
 * How long a question waits for a tap: QUESTION_TIMEOUT_MINUTES, 10 by
 * default. One clock for everything a turn stops to ask — telecoder_ask_user,
 * telecoder_poll_user, a relayed Claude Code dialog. Permission prompts and
 * held messages keep their own, PERMISSION_PROMPT_TIMEOUT_MINUTES.
 */
export function questionTimeoutMinutes(): number {
  const minutes = config.QUESTION_TIMEOUT_MINUTES;
  return Number.isFinite(minutes) && minutes > 0 ? minutes : 10;
}

export function questionTimeoutMs(): number {
  return questionTimeoutMinutes() * 60 * 1000;
}

/**
 * Build the plain-text body for an ask_user Telegram message, for the IPC
 * handler in mcp-bridge.ts.
 *
 * Layout:
 *   ❓ <question>
 *
 *   <context>              ← only when provided; the model's decision rationale
 *
 *   A. Label — description  ← every option, keyed by its letter
 *
 *   ✏️ Or reply with your own answer.
 *
 * The `context` block is the fix for the "user is asked to choose before the
 * explanation is shown" bug: prose the model emits *before* calling ask_user
 * isn't delivered until end-of-turn (after the tap), so decision-relevant
 * information must ride inside the question message itself.
 */
export function buildAskUserMessageText(
  question: string,
  options: LetteredOption[],
  context?: string,
): string {
  const lines: string[] = [`❓ ${question}`];

  const ctx = context?.trim();
  if (ctx) {
    const clipped = ctx.length > MAX_CONTEXT_LEN ? ctx.slice(0, MAX_CONTEXT_LEN - 1) + '…' : ctx;
    lines.push('');
    lines.push(clipped);
  }

  // Every option, always — not just the ones that came with a description.
  // A button is not a reliable place to read a label from: Telegram clips a
  // long one and offers no way to see the rest, so the body is where an
  // option's full text lives and the letter is how its button points back at
  // it.
  lines.push('');
  lines.push(...letteredOptionLines(options));
  lines.push('');
  lines.push(TYPED_ANSWER_HINT);

  return lines.join('\n');
}

/**
 * The inline keyboard for a question, for the IPC handler in mcp-bridge.ts —
 * rendered like every other lettered picker, through {@link buildLetteredKeyboard}.
 */
export function buildAskUserKeyboard(
  id: string,
  options: LetteredOption[],
): { text: string; callback_data: string }[][] {
  return buildLetteredKeyboard(
    options.map((o, idx) => ({ label: o.label, callbackData: `q:${id}:${idx}` })),
  );
}

/**
 * Rewrite an answered question's text so it no longer reads as unanswered once
 * the keyboard is stripped. Returns `null` when the footer won't fit (or there
 * is no original text to append to) — the caller should then drop the keyboard
 * on its own and let the separate confirmation message carry the answer.
 *
 * The length check is not theoretical: `context` may be up to
 * {@link MAX_CONTEXT_LEN} chars, so a long question plus annotated options can
 * sit close enough to Telegram's 4096-char ceiling that appending a footer
 * tips the edit into a 400 — which would leave a live-looking keyboard on a
 * question that has already been resolved.
 */
export function appendAnsweredFooter(original: string, label: string): string | null {
  return appendFooter(original, `✅ Answered: ${label}`);
}

/**
 * The counterpart of {@link appendAnsweredFooter} for a question nobody
 * answered: `note` says what happened instead. Same length rule, same `null`.
 */
export function appendExpiredFooter(original: string, note: string): string | null {
  return appendFooter(original, `⏱️ ${note}`);
}

function appendFooter(original: string, footer: string): string | null {
  if (!original) return null;
  const appended = `${original}\n\n${footer}`;
  return appended.length > MAX_MESSAGE_LEN ? null : appended;
}

/**
 * The line an ask_user question ends on once it expires.
 */
export function buildAskUserExpiredNote(): string {
  return `No answer within ${questionTimeoutMinutes()} min, so Claude carried on without one.`;
}

/**
 * Wait for a question's answer, or for the tool call that asked it to hang up:
 * claude cancelled the call, as it does when its turn is stopped, or its pty
 * went away. `'hung-up'` then, and the caller withdraws the question and
 * closes its message, which would otherwise wait out the clock looking live
 * and take the next message typed for its answer.
 */
export function answerOrHangUp<T>(answer: Promise<T>, signal?: AbortSignal): Promise<T | 'hung-up'> {
  if (!signal) return answer;
  if (signal.aborted) return Promise.resolve('hung-up');
  return new Promise((resolve) => {
    const onAbort = (): void => resolve('hung-up');
    signal.addEventListener('abort', onAbort, { once: true });
    void answer.then((value) => {
      signal.removeEventListener('abort', onAbort);
      resolve(value);
    });
  });
}

/**
 * Close a question nobody answered in time: take its keyboard down and say
 * what happened where the answer would have gone.
 *
 * A tap is the only other thing that strips a keyboard, so without this a
 * question that simply ran out of time kept buttons that looked as live as
 * the moment they were posted — and tapping one got nothing but a toast. Each
 * caller runs it once its wait comes back empty, with the text it sent and
 * the entities too, when it sent some: an edit that leaves them out drops the
 * formatting. They stay valid because the footer only appends.
 *
 * Best-effort, like the answered path in bot.ts. A footer that won't fit or an
 * edit Telegram refuses still gets the keyboard taken down on its own.
 */
export async function closeExpiredQuestion(
  api: Pick<Api, 'editMessageText' | 'editMessageReplyMarkup'>,
  message: { chat: { id: number }; message_id: number },
  text: string,
  note: string,
  entities?: MessageEntity[],
): Promise<void> {
  await closeQuestion(api, message, appendExpiredFooter(text, note), entities);
}

/**
 * Close a question answered by something other than a tap, which bot.ts
 * closes itself: a typed answer. Same fallbacks as {@link closeExpiredQuestion}.
 */
export async function closeAnsweredQuestion(
  api: Pick<Api, 'editMessageText' | 'editMessageReplyMarkup'>,
  message: { chat: { id: number }; message_id: number },
  text: string,
  label: string,
): Promise<void> {
  await closeQuestion(api, message, appendAnsweredFooter(text, label));
}

/** Close a question claude stopped waiting on (see {@link answerOrHangUp}). Same fallbacks. */
export async function closeWithdrawnQuestion(
  api: Pick<Api, 'editMessageText' | 'editMessageReplyMarkup'>,
  message: { chat: { id: number }; message_id: number },
  text: string,
): Promise<void> {
  await closeQuestion(api, message, appendFooter(text, '🚫 Claude stopped waiting for an answer.'));
}

async function closeQuestion(
  api: Pick<Api, 'editMessageText' | 'editMessageReplyMarkup'>,
  message: { chat: { id: number }; message_id: number },
  closed: string | null,
  entities?: MessageEntity[],
): Promise<void> {
  const chatId = message.chat.id;
  if (closed !== null) {
    try {
      await api.editMessageText(chatId, message.message_id, closed, entities ? { entities } : undefined);
      return;
    } catch {
      // Losing the note is cosmetic; a live keyboard on a closed question is
      // not — fall through and take the keyboard down on its own.
    }
  }
  try {
    await api.editMessageReplyMarkup(chatId, message.message_id);
  } catch (err) {
    // Nothing left to try here. A tap on it still gets the expired answer,
    // and the tap handler strips the keyboard then.
    console.warn('[AskUser] could not close a question:', err instanceof Error ? err.message : err);
  }
}

/**
 * The confirmation sent as its own message once a question is answered.
 *
 * Editing the question in place is silent and anonymous: Telegram raises no
 * notification for an edit, and the footer says nothing about who tapped. In a
 * group that means the rest of the chat never sees a decision was made. A
 * standalone message replying to the question puts the answer in the
 * conversation flow the way a typed reply would be, and names the person.
 */
export function buildAnswerConfirmation(
  label: string,
  opts: { isPrivate: boolean; who?: string },
): string {
  const who = opts.isPrivate ? 'You' : opts.who?.trim() || 'Someone';
  return `✅ ${who} picked: ${label}`;
}

interface PendingEntry {
  resolve: (answer: AskUserAnswer | null) => void;
  timer: NodeJS.Timeout;
  optionLabels: string[];
  sessionKey?: string;
  /**
   * When set, only these Telegram user ids may answer. Left undefined the
   * question is open to anyone the auth middleware already let in, which is
   * what an ordinary `telecoder_ask_user` wants — the whole point of a poll
   * in a group is that any member can answer it.
   *
   * The permission gate sets it, because a question guarding a destructive
   * command is not answered by whoever asked for the command.
   */
  allowedResponderIds?: number[];
  /**
   * When set, the asker keeps the message: a tap only resolves the promise,
   * and the tap handler neither stamps the answer on the message nor takes
   * the keyboard down nor confirms the pick in a reply. For a question whose
   * answer may be "ask me again with fresh numbers" — the memory guard's
   * "Check again" — and so re-posts itself over the same message. The asker
   * closes it when the exchange is over.
   */
  ownerCloses?: boolean;
}

/**
 * Outcome of a button tap.
 *   - `resolved`  — the waiting agent got its answer
 *   - `expired`   — no such question: already answered, or timed out
 *   - `forbidden` — this question is restricted and the tapper is not on the list
 */
export type ResolveOutcome = 'resolved' | 'expired' | 'forbidden';

const pending: Map<string, PendingEntry> = new Map();
// Per-sessionKey pending counter: the status bubble reads it to say the turn
// is waiting on the user. A counter, not a boolean, for the rare overlapping
// asks in one session.
const pendingBySession: Map<string, number> = new Map();

function clearPending(id: string): PendingEntry | undefined {
  const entry = pending.get(id);
  if (!entry) return undefined;
  pending.delete(id);
  clearTimeout(entry.timer);
  if (entry.sessionKey) {
    const next = (pendingBySession.get(entry.sessionKey) ?? 1) - 1;
    if (next <= 0) pendingBySession.delete(entry.sessionKey);
    else pendingBySession.set(entry.sessionKey, next);
  }
  return entry;
}

/**
 * Register a new pending question. Returns a short id (hex) and a promise
 * that resolves with the user's selected option, or `null` on timeout.
 */
export function createPendingQuestion(
  optionLabels: string[],
  timeoutMs: number = questionTimeoutMs(),
  sessionKey?: string,
  allowedResponderIds?: number[],
  opts?: { ownerCloses?: boolean },
): { id: string; promise: Promise<AskUserAnswer | null> } {
  const id = crypto.randomBytes(4).toString('hex');
  let resolveFn!: (answer: AskUserAnswer | null) => void;
  const promise = new Promise<AskUserAnswer | null>((resolve) => {
    resolveFn = resolve;
  });

  const timer = setTimeout(() => {
    const entry = clearPending(id);
    if (entry) entry.resolve(null);
  }, timeoutMs);

  pending.set(id, {
    resolve: resolveFn,
    timer,
    optionLabels,
    sessionKey,
    ...(allowedResponderIds && allowedResponderIds.length > 0 ? { allowedResponderIds } : {}),
    ...(opts?.ownerCloses ? { ownerCloses: true } : {}),
  });
  if (sessionKey) {
    pendingBySession.set(sessionKey, (pendingBySession.get(sessionKey) ?? 0) + 1);
  }
  return { id, promise };
}

/**
 * Take a question back without answering it: its promise never settles, and a
 * later tap gets the expired toast. For an asker that stopped needing the
 * answer — the memory guard whose wait found room before anyone tapped, or
 * an ask_user call claude cancelled.
 */
export function withdrawPendingQuestion(id: string): void {
  clearPending(id);
}

/**
 * Resolve a pending question with the user's selection. Called by the
 * Telegram callback-query dispatcher on button tap.
 *
 * The responder check lives in here rather than at the call site on purpose:
 * a restricted question must be impossible to resolve without passing the id
 * of whoever tapped, so a future caller cannot forget the check and quietly
 * reopen the question to everyone.
 */
export function resolvePendingQuestion(
  id: string,
  optionIndex: number,
  responderId?: number,
): ResolveOutcome {
  const entry = claimPending(id, responderId);
  if (typeof entry === 'string') return entry;
  const label = entry.optionLabels[optionIndex];
  if (label === undefined) {
    entry.resolve(null);
    return 'resolved';
  }
  entry.resolve({ label, index: optionIndex });
  return 'resolved';
}

/**
 * Resolve a pending question with an answer the user typed instead of tapping
 * (see typed-answer.ts). Same outcomes, and the same responder check, as
 * {@link resolvePendingQuestion}.
 */
export function resolvePendingQuestionWithText(
  id: string,
  text: string,
  responderId?: number,
): ResolveOutcome {
  const entry = claimPending(id, responderId);
  if (typeof entry === 'string') return entry;
  entry.resolve({ label: text, index: -1, typed: true });
  return 'resolved';
}

/** Take a question off the books for this responder to answer, or say why they can't. */
function claimPending(id: string, responderId?: number): PendingEntry | 'expired' | 'forbidden' {
  const entry = pending.get(id);
  if (!entry) return 'expired';

  const allowed = entry.allowedResponderIds;
  // Fails closed: no responder id on a restricted question is a refusal, not
  // a pass. Unrestricted questions ignore the id entirely.
  if (allowed && (responderId === undefined || !allowed.includes(responderId))) {
    return 'forbidden';
  }

  clearPending(id);
  return entry;
}

/** Whether the asker closes this question's message itself (see PendingEntry.ownerCloses). Read before resolving: resolving drops the entry. */
export function questionOwnerCloses(id: string): boolean {
  return pending.get(id)?.ownerCloses === true;
}

/**
 * The full label of one option on a pending question — what the model wrote,
 * not what its button shows. The two part company as soon as a keyboard goes
 * compact and the button is a bare `A`, and it is the model's text that
 * belongs in the answered footer and the confirmation message. Read it before
 * resolving; resolving drops the entry.
 */
export function getQuestionOptionLabel(id: string, index: number): string | undefined {
  return pending.get(id)?.optionLabels[index];
}

/**
 * The ids allowed to answer this question, or undefined when it is open to
 * everyone. Lets the callback handler tell the tapper who they are waiting on
 * instead of a bare refusal.
 */
export function getQuestionResponders(id: string): number[] | undefined {
  return pending.get(id)?.allowedResponderIds;
}

/**
 * Count a wait on the user that isn't a button question, such as a secret
 * request, as one: the status bubble says the turn is waiting on them.
 * Returns the call that ends the wait, which is safe to make more than once.
 */
export function noteAwaitingUser(sessionKey: string): () => void {
  pendingBySession.set(sessionKey, (pendingBySession.get(sessionKey) ?? 0) + 1);
  let ended = false;
  return () => {
    if (ended) return;
    ended = true;
    const next = (pendingBySession.get(sessionKey) ?? 1) - 1;
    if (next <= 0) pendingBySession.delete(sessionKey);
    else pendingBySession.set(sessionKey, next);
  };
}

/**
 * True when there's an outstanding ask-user question for this sessionKey.
 * The status bubble uses this to say the turn is parked on the user, where
 * it would otherwise go on animating "Thinking…".
 */
export function hasPendingQuestionForSession(sessionKey: string): boolean {
  return (pendingBySession.get(sessionKey) ?? 0) > 0;
}
