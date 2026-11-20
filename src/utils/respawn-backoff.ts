/**
 * Backoff policy for respawning a bot instance that exited unexpectedly.
 *
 * Kept separate from the launcher so it can be tested directly — the launcher
 * spawns worker threads and reads config at import time, and this is the part
 * that only ever runs when something has already gone wrong.
 */

export interface RespawnPlan {
  /** Consecutive-crash count after this exit, to carry into the next one. */
  streak: number;
  /** How long to wait before respawning, or null to stop trying. */
  delayMs: number | null;
}

export interface RespawnInput {
  /** How long the instance stayed up before exiting. */
  aliveMs: number;
  /** Consecutive crashes recorded before this one. */
  previousStreak: number;
  /** One delay per attempt; running out of them is what giving up means. */
  delays: readonly number[];
  /** An instance that stayed up at least this long starts its budget over. */
  streakResetMs: number;
}

/**
 * Decide whether a crashed instance gets another respawn, and how long to wait.
 *
 * Crashes only accumulate while they cluster. An instance that survived
 * `streakResetMs` before dying is treated as a first crash again, so two
 * unrelated failures days apart never add up to a give-up.
 */
export function planRespawn({
  aliveMs,
  previousStreak,
  delays,
  streakResetMs,
}: RespawnInput): RespawnPlan {
  const streak = aliveMs >= streakResetMs ? 1 : previousStreak + 1;
  return { streak, delayMs: delays[streak - 1] ?? null };
}

export interface OutageRespawnInput {
  /** How long the instance stayed up before exiting. */
  aliveMs: number;
  /** Outage respawns in a row before this one. */
  previousAttempts: number;
  /** The waits to go through; the last one repeats for as long as it takes. */
  delays: readonly number[];
  /** An instance that stayed up at least this long starts the waits over. */
  streakResetMs: number;
}

/**
 * How long to wait before respawning an instance that exited because Telegram
 * couldn't be reached. Unlike a crash this never gives up: an outage ends on
 * its own, and the bot should be back when it does.
 */
export function planOutageRespawn({
  aliveMs,
  previousAttempts,
  delays,
  streakResetMs,
}: OutageRespawnInput): { attempts: number; delayMs: number } {
  const attempts = aliveMs >= streakResetMs ? 1 : previousAttempts + 1;
  return { attempts, delayMs: delays[Math.min(attempts, delays.length) - 1] };
}
