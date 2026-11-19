/**
 * Albums: files sent together, gathered into one message.
 *
 * Telegram has no message holding several files. Files picked together and sent
 * with "Group items" on arrive one message each, sharing a `media_group_id`,
 * with the caption on just one of them. Taken one at a time, each became a turn
 * of its own: Claude answered once per file, never knowing the others came with
 * it, and all but one went without the caption.
 *
 * So the parts are gathered here into the first to arrive, which carries the
 * others in `album` and goes on alone. handlers/album.handler.ts sends the lot
 * as one prompt. The others leave the stream.
 *
 * The caption moves onto that first part when another has it. The group
 * mention gate reads it to decide whether a message is for the bot, and this
 * runs ahead of the gate, since a part without the caption would fail it on its
 * own. It runs behind auth, so only an allowed sender's parts are gathered, and
 * ahead of sequentialize, like the message batcher: the parts would otherwise
 * wait there behind the first one's turn.
 *
 * The parts ride on the message itself, so they stay with a message set aside
 * and sent later, which comes back through here and goes straight on.
 */

import { type Context, type MiddlewareFn } from 'grammy';
import type { Message } from 'grammy/types';

/**
 * How long after the last part an album is taken as complete. A client uploads
 * every file before it sends any of the messages, so the parts arrive within
 * moments of each other.
 */
export const ALBUM_WAIT_MS = 1000;

interface PendingAlbum {
  parts: Message[];
  timer: NodeJS.Timeout;
  resolve: () => void;
}

const albums: Map<string, PendingAlbum> = new Map();

/** The other parts of the album this message leads, or undefined when it leads none. */
export function albumParts(message: object | undefined): Message[] | undefined {
  return (message as { album?: Message[] } | undefined)?.album;
}

export function createAlbumMiddleware(): MiddlewareFn<Context> {
  return async (ctx, next) => {
    const message = ctx.message;
    const groupId = message?.media_group_id;
    if (!message || !groupId || albumParts(message) || !ctx.chat) return next();

    const key = `${ctx.chat.id}:${groupId}`;
    const existing = albums.get(key);
    if (existing) {
      existing.parts.push(message);
      existing.timer.refresh();
      return; // absorbed into the album's first part
    }

    const parts: Message[] = [];
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        albums.delete(key);
        resolve();
      }, ALBUM_WAIT_MS);
      albums.set(key, { parts, timer, resolve });
    });

    if (parts.length > 0) {
      const captioned = message.caption ? undefined : parts.find((part) => part.caption);
      if (captioned) {
        Object.assign(message, { caption: captioned.caption, caption_entities: captioned.caption_entities });
        delete (captioned as { caption?: string }).caption;
        delete (captioned as { caption_entities?: unknown }).caption_entities;
      }
      console.log(`[Album] Gathered ${parts.length + 1} files sent together`);
      Object.assign(message, { album: parts });
    }
    return next();
  };
}
