import { spinner } from "@clack/prompts";
import { Data, Effect, Option } from "effect";
import { isCancel, select as clackSelect } from "@clack/prompts";
import { matchSorter } from "match-sorter";

export const spin = Effect.fn("lib/spin")(function* <V, E, R>(
  message: string,
  job: Effect.Effect<V, E, R>
) {
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

export const select = Effect.fn("lib/select")(function* <T>(
  message: string,
  options: { value: T; label: string }[]
) {
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

export function matchEnum<T extends Record<string, string | number>>(
  enumToParse: T,
  value: string
) {
  const entries = Object.entries(enumToParse).map(([k, v]) => ({
    value: v as T[keyof T],
    labels: [enumToParse[k as keyof T], enumToParse[v as keyof T]],
  }));
  const matched = matchSorter(entries, value.toString(), {
    keys: ["labels"],
  })[0]?.value;
  return Option.fromNullable(matched);
}
