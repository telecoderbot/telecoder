import { describe, it, expect } from 'vitest';
import { planOutageRespawn, planRespawn } from '../../src/utils/respawn-backoff.js';

const DELAYS = [1_000, 5_000, 15_000, 60_000] as const;
const RESET_MS = 300_000;

const plan = (aliveMs: number, previousStreak: number) =>
  planRespawn({ aliveMs, previousStreak, delays: DELAYS, streakResetMs: RESET_MS });

describe('planRespawn', () => {
  it('respawns a first-time crash on the shortest delay', () => {
    expect(plan(10_000, 0)).toEqual({ streak: 1, delayMs: 1_000 });
  });

  it('lengthens the wait as crashes pile up', () => {
    expect(plan(2_000, 1).delayMs).toBe(5_000);
    expect(plan(2_000, 2).delayMs).toBe(15_000);
    expect(plan(2_000, 3).delayMs).toBe(60_000);
  });

  it('gives up once the delays run out', () => {
    const { streak, delayMs } = plan(2_000, DELAYS.length);
    expect(streak).toBe(DELAYS.length + 1);
    expect(delayMs).toBeNull();
  });

  it('starts the budget over for an instance that stayed up', () => {
    // The failure this guards: a bot that ran for hours, crashed once, and was
    // refused a respawn because of crashes from days earlier.
    expect(plan(RESET_MS, 3)).toEqual({ streak: 1, delayMs: 1_000 });
    expect(plan(RESET_MS * 100, DELAYS.length)).toEqual({ streak: 1, delayMs: 1_000 });
  });

  it('counts a crash just under the reset threshold as part of the streak', () => {
    expect(plan(RESET_MS - 1, 1)).toEqual({ streak: 2, delayMs: 5_000 });
  });

  it('keeps giving up while an instance stays broken', () => {
    // Once past the budget, every further immediate crash stays refused rather
    // than wrapping around to a short delay again.
    for (let previous = DELAYS.length; previous < DELAYS.length + 5; previous++) {
      expect(plan(500, previous).delayMs).toBeNull();
    }
  });
});

describe('planOutageRespawn', () => {
  const OUTAGE_DELAYS = [5_000, 15_000, 60_000, 300_000] as const;
  const outage = (aliveMs: number, previousAttempts: number) =>
    planOutageRespawn({ aliveMs, previousAttempts, delays: OUTAGE_DELAYS, streakResetMs: RESET_MS });

  it('lengthens the wait while Telegram stays down', () => {
    expect(outage(16_000, 0)).toEqual({ attempts: 1, delayMs: 5_000 });
    expect(outage(16_000, 1).delayMs).toBe(15_000);
    expect(outage(16_000, 2).delayMs).toBe(60_000);
    expect(outage(16_000, 3).delayMs).toBe(300_000);
  });

  it('never gives up, repeating the last wait', () => {
    // The failure this guards: a few minutes of 502s outlasted the crash
    // retries, and the bot stayed offline until the launcher was restarted.
    for (let previous = OUTAGE_DELAYS.length; previous < OUTAGE_DELAYS.length + 50; previous++) {
      expect(outage(16_000, previous).delayMs).toBe(300_000);
    }
  });

  it('starts the waits over for an instance that stayed up', () => {
    expect(outage(RESET_MS, 7)).toEqual({ attempts: 1, delayMs: 5_000 });
  });
});
