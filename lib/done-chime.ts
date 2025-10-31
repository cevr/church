import { Effect } from 'effect';

// this is playing on the terminal
export const doneChime = Effect.sync(() => process.stdout.write('\x07'));
