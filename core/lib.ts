import { spinner } from "@clack/prompts";
import { Data, Effect } from "effect";
import { isCancel, select as clackSelect } from "@clack/prompts";

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

export class SelectError extends Data.TaggedError("SelectError")<{
  message: string;
  cause: unknown;
}> {}

export const select = <T extends string | boolean | number>(
  message: string,
  options: { value: T; label: string }[]
) =>
  Effect.gen(function* () {
    const result = yield* Effect.tryPromise({
      try: () =>
        clackSelect({
          message,
          options: options as any,
        }),
      catch: (cause: unknown) =>
        new SelectError({
          message: `Failed to select action: ${cause}`,
          cause,
        }),
    });

    if (isCancel(result)) {
      return yield* Effect.dieMessage("selection cancelled");
    }

    return result as T;
  });
