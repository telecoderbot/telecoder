/**
 * Threads marked with /keep, which /cleanup leaves alone.
 *
 * A thread is kept until /keep off, or until it's deleted anyway (by
 * /deletethread, or by hand): a deleted thread has nothing left to keep.
 * Kept per bot, since each bot has its own threads.
 */

import * as path from 'path';
import { z } from 'zod';
import { BOT_ID } from '../config.js';
import { ensureStateDir, getStateDir, readJsonFile, writeJsonFile } from '../utils/json-store.js';

const fileSchema = z.object({ threads: z.array(z.string()) });

/** What goes in front of a kept thread's name, where the bot names it. */
export const KEEP_MARK = '📌 ';

let keptSet: Set<string> | undefined;

function stateFile(): string {
  return path.join(getStateDir(), `kept-threads-${BOT_ID}.json`);
}

function kept(): Set<string> {
  keptSet ??= new Set(readJsonFile(stateFile(), fileSchema, 'KeptThreads')?.threads ?? []);
  return keptSet;
}

function save(): void {
  ensureStateDir(getStateDir(), 'KeptThreads');
  writeJsonFile(stateFile(), { threads: [...kept()] }, 'KeptThreads');
}

export function isThreadKept(sessionKey: string): boolean {
  return kept().has(sessionKey);
}

/** Mark or unmark a thread. Whether that changed anything. */
export function setThreadKept(sessionKey: string, keep: boolean): boolean {
  if (kept().has(sessionKey) === keep) return false;
  if (keep) kept().add(sessionKey);
  else kept().delete(sessionKey);
  save();
  return true;
}

/** Drop the mark of a thread that no longer exists. */
export function forgetKeptThread(sessionKey: string): void {
  if (kept().delete(sessionKey)) save();
}

/** Test seam: forget every mark, on disk too. */
export function resetKeptThreadsForTest(): void {
  keptSet = new Set();
  save();
}
