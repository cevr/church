import { Path } from '@effect/platform';
import { $ } from 'bun';
import { Effect } from 'effect';

// this is playing on the terminal
export const doneChime = Effect.gen(function* () {
  const path = yield* Path.Path;
  const assetPath = path.join(process.cwd(), 'assets', 'notification.mp3');

  yield* Effect.tryPromise(async () => await $`afplay ${assetPath} -v 0.15`);
});
