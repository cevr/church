import { log as clackLog } from '@clack/prompts';
import { Effect } from 'effect';

export const log = {
  info: (message: string) => Effect.sync(() => clackLog.info(message)),
  error: (message: string) => Effect.sync(() => clackLog.error(message)),
  success: (message: string) => Effect.sync(() => clackLog.success(message)),
  warn: (message: string) => Effect.sync(() => clackLog.warn(message)),
};
