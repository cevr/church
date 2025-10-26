import { spinner } from '@clack/prompts';
import { Effect, Option } from 'effect';
import { matchSorter } from 'match-sorter';

export const spin = Effect.fn('prelude/spin')(function* <V, E, R>(
  message: string,
  job: Effect.Effect<V, E, R>,
) {
  const start = Date.now();
  const s = yield* Effect.sync(() => spinner());
  yield* Effect.sync(() => s.start(message + '...'));
  const result = yield* job.pipe(
    Effect.tap(() =>
      Effect.sync(() =>
        s.stop(`${message} done! (${msToMinutes(Date.now() - start)})`),
      ),
    ),
    Effect.tapError(() =>
      Effect.sync(() =>
        s.stop(`${message} failed! (${msToMinutes(Date.now() - start)})`),
      ),
    ),
    Effect.tapDefect(() =>
      Effect.sync(() =>
        s.stop(`${message} failed! (${msToMinutes(Date.now() - start)})`),
      ),
    ),
  );

  return result;
});

export const msToMinutes = (ms: number) => {
  const minutes = Math.floor(ms / 60000);
  const seconds = Math.floor((ms % 60000) / 1000);
  return `${minutes}m:${seconds.toString().padStart(2, '0')}s`;
};

export function matchEnum<T extends Record<string, string | number>>(
  enumToParse: T,
  value: string,
) {
  const entries = Object.entries(enumToParse).map(([k, v]) => ({
    value: v as T[keyof T],
    labels: [enumToParse[k as keyof T], enumToParse[v as keyof T]],
  }));
  const matched = matchSorter(entries, value.toString(), {
    keys: ['labels'],
  })[0]?.value;
  return Option.fromNullable(matched);
}
