import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Context } from 'grammy';
import type { Message } from 'grammy/types';
import { ALBUM_WAIT_MS, albumParts, createAlbumMiddleware } from '../../src/bot/middleware/album-collector.js';
import { albumPrompt } from '../../src/bot/handlers/album.handler.js';
import { summarizeUserPrompt } from '../../src/telegram/prompt-label.js';

function partCtx(messageId: number, extra: Partial<Message> = {}, groupId: string | null = 'g1'): Context {
  const message = { message_id: messageId, date: 0, chat: { id: 1 }, media_group_id: groupId ?? undefined, ...extra };
  return { chat: { id: 1 }, message } as unknown as Context;
}

describe('album collector', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('lets a file sent alone through at once', async () => {
    const next = vi.fn(async () => {});
    await createAlbumMiddleware()(partCtx(1, {}, null), next);
    expect(next).toHaveBeenCalledOnce();
  });

  it('hands on the first part carrying the others', async () => {
    const collect = createAlbumMiddleware();
    const next = vi.fn(async () => {});
    const first = partCtx(1);

    const done = collect(first, next);
    await collect(partCtx(2), next);
    await vi.advanceTimersByTimeAsync(ALBUM_WAIT_MS / 2);
    await collect(partCtx(3), next);
    // The wait starts over with each part.
    await vi.advanceTimersByTimeAsync(ALBUM_WAIT_MS - 1);
    expect(next).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    await done;
    expect(next).toHaveBeenCalledOnce();
    expect(albumParts(first.message)?.map((m) => m.message_id)).toEqual([2, 3]);
  });

  it('moves the caption onto the part it hands on', async () => {
    const collect = createAlbumMiddleware();
    const next = vi.fn(async () => {});
    const first = partCtx(1);
    const second = partCtx(2, { caption: '@bot compare these', caption_entities: [{ type: 'mention', offset: 0, length: 4 }] });

    const done = collect(first, next);
    await collect(second, next);
    await vi.advanceTimersByTimeAsync(ALBUM_WAIT_MS);
    await done;

    expect(first.message!.caption).toBe('@bot compare these');
    expect(first.message!.caption_entities).toHaveLength(1);
    expect(second.message!.caption).toBeUndefined();
  });

  it('keeps albums from different groups apart', async () => {
    const collect = createAlbumMiddleware();
    const next = vi.fn(async () => {});
    const a = partCtx(1, {}, 'a');
    const b = partCtx(2, {}, 'b');

    const doneA = collect(a, next);
    const doneB = collect(b, next);
    await vi.advanceTimersByTimeAsync(ALBUM_WAIT_MS);
    await Promise.all([doneA, doneB]);

    expect(next).toHaveBeenCalledTimes(2);
    expect(albumParts(a.message)).toBeUndefined();
    expect(albumParts(b.message)).toBeUndefined();
  });

  it('sends a gathered album on at once when it comes back through', async () => {
    const next = vi.fn(async () => {});
    const replayed = partCtx(1, { album: [{ message_id: 2 }] } as Partial<Message>);
    await createAlbumMiddleware()(replayed, next);
    expect(next).toHaveBeenCalledOnce();
  });
});

describe('albumPrompt', () => {
  it('lists every file, with the caption once', () => {
    const prompt = albumPrompt([
      { name: 'Photo', kind: 'image', path: '/up/a.jpg' },
      { name: 'Photo', kind: 'image', path: '/up/b.png', caption: 'the old one' },
      { name: 'spec.pdf', kind: 'file', path: '/up/spec.pdf' },
      { name: 'clip.mp4', skipped: "video isn't supported" },
    ], 'which matches the spec?');

    expect(prompt).toBe([
      'User sent 4 files together.',
      '1. Photo, saved at: /up/a.jpg',
      '2. Photo, saved at: /up/b.png',
      '   With its own caption: "the old one"',
      '3. spec.pdf, saved at: /up/spec.pdf',
      "4. clip.mp4, not available: video isn't supported",
      'Caption: "which matches the spec?"',
      'The images are attached as vision input — you can see them directly. Use the Read tool for the other files. For PDFs use Read with `pages` for large files.',
      'They were sent as one message, so take them together. If the caption includes a question or request, answer it. Otherwise say briefly what they are and ask what they want done with them.',
    ].join('\n'));
  });

  it('asks for Read alone when there are no images', () => {
    const prompt = albumPrompt([
      { name: 'a.txt', kind: 'file', path: '/up/a.txt' },
      { name: 'b.txt', kind: 'file', path: '/up/b.txt' },
    ], undefined);
    expect(prompt).toContain('Caption: (none)\nUse the Read tool to read their contents.');
  });

  it('shows up in the prompt lists as the files and the caption', () => {
    const prompt = albumPrompt([
      { name: 'Photo', kind: 'image', path: '/up/a.jpg' },
      { name: 'Photo', kind: 'image', path: '/up/b.jpg' },
    ], 'spot the difference');
    expect(summarizeUserPrompt(prompt)).toBe('📎 2 files — spot the difference');
  });
});
