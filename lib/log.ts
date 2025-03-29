import { Effect } from "effect";
import { log as clackLog } from "@clack/prompts";

export const log = {
  info: (message: string) => Effect.sync(() => clackLog.info(message)),
  error: (message: string) => Effect.sync(() => clackLog.error(message)),
  success: (message: string) => Effect.sync(() => clackLog.success(message)),
  warn: (message: string) => Effect.sync(() => clackLog.warn(message)),
};
