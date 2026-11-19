import { Context } from 'grammy';
import type { Message } from 'grammy/types';
import { config } from '../../config.js';
import { isDuplicate, markProcessed } from '../../telegram/deduplication.js';
import { isStaleMessage } from '../middleware/stale-filter.js';
import { albumParts } from '../middleware/album-collector.js';
import { sanitizeError } from '../../utils/sanitize.js';
import { getSessionKeyFromCtx } from '../../utils/session-key.js';
import { ensureUploadsDir } from '../../utils/uploads-dir.js';
import { requireSession } from './session-guard.js';
import { exceedsDownloadLimit, TELEGRAM_DOWNLOAD_LIMIT_MB } from './media-fallback.js';
import {
  imageAttachment,
  pickLargestPhoto,
  runUploadTurn,
  saveDocument,
  saveImageDocument,
  savePhoto,
} from './photo.handler.js';

/** A part of an album as it went to Claude: saved, or left out and why. */
export type AlbumFile =
  | { name: string; kind: 'image' | 'file'; path: string; caption?: string }
  | { name: string; skipped: string };

type SavedFile = Extract<AlbumFile, { kind: string }>;
type SkippedFile = Extract<AlbumFile, { skipped: string }>;

const isSaved = (file: AlbumFile): file is SavedFile => 'kind' in file;
const isSkipped = (file: AlbumFile): file is SkippedFile => 'skipped' in file;

function sizeMB(bytes?: number): number {
  return (bytes ?? 0) / (1024 * 1024);
}

/** Why a file of this size can't be taken, or undefined when it can. */
function tooLarge(bytes: number | undefined, limitMB: number): string | undefined {
  if (exceedsDownloadLimit(bytes)) return `too large (${sizeMB(bytes).toFixed(1)}MB), Telegram caps bot downloads at ${TELEGRAM_DOWNLOAD_LIMIT_MB}MB`;
  if (sizeMB(bytes) > limitMB) return `too large (${sizeMB(bytes).toFixed(1)}MB), the limit is ${limitMB}MB`;
  return undefined;
}

/**
 * Save one part of an album the way it would be saved sent alone. A part that
 * can't be read comes back as skipped rather than failing the rest.
 */
async function saveAlbumPart(ctx: Context, uploadsDir: string, part: Message, stamp: string): Promise<AlbumFile> {
  const caption = part.caption?.trim() || undefined;
  const doc = part.document;
  const name = part.photo ? 'Photo'
    : doc?.file_name ?? part.video?.file_name ?? part.audio?.file_name ?? part.animation?.file_name ?? 'file';
  const mime = doc?.mime_type ?? '';

  if (part.video || part.animation || mime.startsWith('video/')) return { name, skipped: "video isn't supported" };
  if (part.audio || mime.startsWith('audio/')) return { name, skipped: "audio files aren't supported" };
  if (!part.photo && !doc) return { name, skipped: "this kind of message isn't supported" };

  const isImage = !!part.photo || mime.startsWith('image/');
  const bytes = part.photo ? pickLargestPhoto(part.photo).file_size : doc?.file_size;
  const limit = isImage ? config.IMAGE_MAX_FILE_SIZE_MB : config.DOCUMENT_MAX_FILE_SIZE_MB;
  const oversize = tooLarge(bytes, limit);
  if (oversize) return { name, skipped: oversize };

  try {
    const path = part.photo ? await savePhoto(ctx, uploadsDir, pickLargestPhoto(part.photo), stamp)
      : isImage ? await saveImageDocument(ctx, uploadsDir, doc!, stamp)
      : await saveDocument(ctx, uploadsDir, doc!, stamp);
    return { name, kind: isImage ? 'image' : 'file', path, caption };
  } catch (error) {
    const reason = sanitizeError(error);
    console.error('[Album] Error:', reason);
    return { name, skipped: reason };
  }
}

/** The note an album becomes for Claude: every file, where it went, and the caption. */
export function albumPrompt(files: AlbumFile[], caption: string | undefined): string {
  const lines = [`User sent ${files.length} files together.`];
  files.forEach((file, i) => {
    if (isSkipped(file)) {
      lines.push(`${i + 1}. ${file.name}, not available: ${file.skipped}`);
      return;
    }
    lines.push(`${i + 1}. ${file.name}, saved at: ${file.path}`);
    if (file.caption) lines.push(`   With its own caption: "${file.caption}"`);
  });
  lines.push(caption ? `Caption: "${caption}"` : 'Caption: (none)');

  const images = files.filter((f) => isSaved(f) && f.kind === 'image').length;
  const others = files.filter((f) => isSaved(f) && f.kind === 'file').length;
  const howToRead = images === 0
    ? 'Use the Read tool to read their contents.'
    : (images === 1
      ? 'The image is attached as a vision input — you can see it directly.'
      : 'The images are attached as vision input — you can see them directly.')
      + (others > 0 ? ' Use the Read tool for the other files.' : '');
  lines.push(others > 0 ? `${howToRead} For PDFs use Read with \`pages\` for large files.` : howToRead);
  lines.push('They were sent as one message, so take them together. If the caption includes a question or request, answer it. Otherwise say briefly what they are and ask what they want done with them.');
  return lines.join('\n');
}

/**
 * Files sent together, gathered by the album collector: saved one by one, then
 * sent to Claude as a single prompt with the images attached.
 */
export async function handleAlbum(ctx: Context): Promise<void> {
  const keyInfo = getSessionKeyFromCtx(ctx);
  const message = ctx.message;
  const others = albumParts(message);
  if (!keyInfo || !message || !others) return;
  const { sessionKey } = keyInfo;

  if (isStaleMessage(message.date)) {
    console.log(`[Album] Ignoring stale album ${message.message_id}`);
    return;
  }
  if (isDuplicate(message.message_id)) {
    console.log(`[Album] Ignoring duplicate album ${message.message_id}`);
    return;
  }
  const parts = [message, ...others].sort((a, b) => a.message_id - b.message_id);
  for (const part of parts) markProcessed(part.message_id);

  const session = await requireSession(ctx, sessionKey);
  if (!session) return;

  const uploadsDir = ensureUploadsDir(session.workingDirectory);
  const stamp = Date.now();
  const files = await Promise.all(parts.map((part, i) => saveAlbumPart(ctx, uploadsDir, part, `${stamp}_${i + 1}`)));

  const skipped = files.filter(isSkipped);
  if (skipped.length > 0) {
    const list = skipped.map((f) => `• ${f.name}: ${f.skipped}`).join('\n');
    const heading = skipped.length === files.length
      ? `❌ None of the ${files.length} files could be read:`
      : `⚠️ ${skipped.length} of the ${files.length} files couldn't be read, so Claude gets the rest:`;
    await ctx.reply(`${heading}\n${list}`);
    if (skipped.length === files.length) return;
  }

  // The collector moved the album's caption onto the message it handed on.
  const caption = message.caption?.trim() || undefined;
  const images = files.filter(isSaved).filter((f) => f.kind === 'image').map((f) => imageAttachment(f.path));
  // The leading message's caption is the album's, so it isn't repeated per file.
  const listed = files.map((f) => (isSaved(f) && f.caption === caption ? { ...f, caption: undefined } : f));

  await runUploadTurn(ctx, sessionKey, albumPrompt(listed, caption), images.length > 0 ? images : undefined);
}
