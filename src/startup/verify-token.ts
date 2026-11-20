/**
 * Ask Telegram who we are before anything else starts.
 *
 * A token with the right shape can still be revoked, or belong to a bot that
 * was deleted. That used to surface from `bot.init()` as a grammY stack trace,
 * after the IPC server was already listening. Checking first means a bad
 * token stops the bot with one sentence and nothing to clean up, and the
 * answer is handed to createBot so the check costs no extra request.
 */

import { Api } from 'grammy';
import type { UserFromGetMe } from 'grammy/types';
import { config } from '../config.js';
import { telegramClientOptions, telegramProxyUrl } from '../telegram/client-options.js';
import { describeTokenCheckFailure } from '../utils/bot-token.js';
import { EXIT_TELEGRAM_UNAVAILABLE, exitForConfigError } from '../utils/exit-codes.js';

/** getMe with the bot's own token and proxy, or exit with a plain-language reason. */
export async function verifyBotTokenOrExit(): Promise<UserFromGetMe> {
  const api = new Api(config.TELEGRAM_BOT_TOKEN, { ...telegramClientOptions(), timeoutSeconds: 30 });
  try {
    return await api.getMe();
  } catch (err) {
    const failure = describeTokenCheckFailure(err, telegramProxyUrl());
    console.error(`❌ ${failure.message}`);
    // A rejected token stays rejected; a network failure or a Telegram error
    // might not, so it exits for whatever restarts the bot to try again.
    if (failure.fatal) exitForConfigError();
    process.exit(EXIT_TELEGRAM_UNAVAILABLE);
  }
}
