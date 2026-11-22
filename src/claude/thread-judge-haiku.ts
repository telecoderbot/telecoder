/**
 * Haiku's guess at which threads /cleanup can delete: for each, whether the
 * work in it looks finished or has loose ends.
 *
 * One call for every thread at once, so a cleanup of thirty threads starts one
 * claude, not thirty. All Haiku sees of a thread is what the chat history
 * keeps: its topic, the last thing the user said and the end of the last
 * reply. That's enough to tell "done, pushed" from "want me to go on?".
 *
 * The guess only decides which threads start ticked. The user reads the list
 * and confirms, so a wrong guess costs a tap. Any failure (timeout, a reply
 * out of format) gives no guess, and /cleanup says so.
 */

import { query } from '@anthropic-ai/claude-agent-sdk';
import { sideCallOptions } from './side-call-options.js';

const JUDGE_TIMEOUT_MS = 45_000;
const MAX_USER_CHARS = 300;
const MAX_REPLY_CHARS = 600;

export type ThreadVerdict = 'done' | 'open';

export interface ThreadSummary {
  topic?: string;
  lastUserMessage?: string;
  lastReply?: string;
}

const INSTRUCTIONS =
  'Each numbered item below is a chat thread between a user and a coding agent: its topic, the user\'s last ' +
  'message and the end of the agent\'s last reply. For each, decide whether the work looks finished (DONE) or ' +
  'has loose ends the user may still want to come back to (OPEN): the agent asked a question or offered a next ' +
  'step that wasn\'t taken up, work was left half done, something failed, or a plan was agreed but not carried out.\n' +
  'When in doubt, answer OPEN.\n' +
  'Output one line per item, nothing else, in the form "<number>: DONE" or "<number>: OPEN".\n\n';

function clip(text: string | undefined, max: number, fromEnd = false): string {
  const flat = (text ?? '').replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  return fromEnd ? '…' + flat.slice(flat.length - max) : flat.slice(0, max) + '…';
}

export function buildJudgePrompt(threads: ThreadSummary[]): string {
  const items = threads.map((t, i) => [
    `${i + 1}.`,
    `Topic: ${clip(t.topic, 120) || '(none)'}`,
    `User: ${clip(t.lastUserMessage, MAX_USER_CHARS) || '(nothing)'}`,
    `Agent: ${clip(t.lastReply, MAX_REPLY_CHARS, true) || '(nothing)'}`,
  ].join('\n'));
  return INSTRUCTIONS + items.join('\n\n');
}

/** The verdicts in a reply, by item; an item Haiku skipped stays undefined. */
export function parseVerdicts(reply: string, count: number): Array<ThreadVerdict | undefined> {
  const verdicts: Array<ThreadVerdict | undefined> = new Array(count).fill(undefined);
  for (const line of reply.split('\n')) {
    const m = /^\s*(\d+)\s*[:.)-]\s*\**\s*(DONE|OPEN)\b/i.exec(line);
    if (!m) continue;
    const index = Number(m[1]) - 1;
    if (index >= 0 && index < count) verdicts[index] = m[2]!.toLowerCase() as ThreadVerdict;
  }
  return verdicts;
}

/** A verdict per thread, or undefined when Haiku gave none at all. */
export async function judgeThreads(threads: ThreadSummary[]): Promise<Array<ThreadVerdict | undefined> | undefined> {
  if (threads.length === 0) return [];
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), JUDGE_TIMEOUT_MS);
  try {
    const response = query({
      prompt: buildJudgePrompt(threads),
      options: sideCallOptions('You sort chat threads into finished and unfinished.', controller),
    });
    let collected = '';
    for await (const message of response) {
      if (message.type === 'assistant') {
        for (const block of message.message.content) {
          if (block.type === 'text') collected += block.text;
        }
      }
      if (message.type === 'result') break;
    }
    const verdicts = parseVerdicts(collected, threads.length);
    return verdicts.some((v) => v !== undefined) ? verdicts : undefined;
  } catch (err) {
    if (!controller.signal.aborted) {
      console.debug('[ThreadJudge] Haiku side-call failed:', err instanceof Error ? err.message : err);
    }
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}
