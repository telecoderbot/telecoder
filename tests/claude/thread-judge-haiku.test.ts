import { describe, it, expect } from 'vitest';
import { buildJudgePrompt, parseVerdicts } from '../../src/claude/thread-judge-haiku.js';

describe('thread judge', () => {
  it('reads one verdict per numbered line, in the forms Haiku tends to write', () => {
    expect(parseVerdicts('1: DONE\n2. open\n3) **OPEN**\n4 - done', 4)).toEqual(['done', 'open', 'open', 'done']);
  });

  it('leaves out items it was not given an answer for, and numbers out of range', () => {
    expect(parseVerdicts('Sure!\n2: DONE\n7: OPEN', 3)).toEqual([undefined, 'done', undefined]);
  });

  it("numbers the threads and keeps the end of a long reply, where the loose ends are", () => {
    const prompt = buildJudgePrompt([
      { topic: 'Cleanup', lastUserMessage: 'go', lastReply: 'x'.repeat(1000) + ' Want me to push?' },
      {},
    ]);
    expect(prompt).toContain('1.\nTopic: Cleanup');
    expect(prompt).toContain('Want me to push?');
    expect(prompt).toContain('2.\nTopic: (none)');
  });
});
