import { spinner } from "@clack/prompts";
import { Effect } from "effect";

export const spin = <V, E, R>(message: string, job: Effect.Effect<V, E, R>) =>
  Effect.gen(function* () {
    const start = Date.now();
    const s = yield* Effect.sync(() => spinner());
    yield* Effect.sync(() => s.start(message + "..."));
    const result = yield* job;
    yield* Effect.sync(() =>
      s.stop(`${message} done! (${msToMinutes(Date.now() - start)})`)
    );
    return result;
  });

export const msToMinutes = (ms: number) => {
  const minutes = Math.floor(ms / 60000);
  const seconds = Math.floor((ms % 60000) / 1000);
  return `${minutes}m:${seconds.toString().padStart(2, "0")}s`;
};
