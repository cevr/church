import { BunFileSystem, BunRuntime } from '@effect/platform-bun';
import { Effect, Layer, Match } from 'effect';

import { main as eldersDigestMain } from './elders-digest/elders-digest';
import { main as messagesMain } from './messages/messages';
import { ModelService } from './model';
import { ParseService } from './parse';
import { main as sabbathSchoolMain } from './sabbath-school/sabbath-school';

enum Command {
  Messages = 'messages',
  SabbathSchool = 'sabbath-school',
  EldersDigest = 'elders-digest',
}

class CommandService extends Effect.Service<CommandService>()('Command', {
  effect: Effect.gen(function* () {
    const parse = yield* ParseService;
    let command = yield* parse.command(Command, {
      message: 'Select a command',
      labels: {
        [Command.Messages]: 'Messages',
        [Command.SabbathSchool]: 'Sabbath School',
        [Command.EldersDigest]: 'Elders Digest',
      },
    });
    return {
      command,
    };
  }),
}) {}

const main = Effect.gen(function* () {
  const { command } = yield* CommandService;

  return yield* Match.value(command).pipe(
    Match.when(Command.Messages, () => messagesMain),
    Match.when(Command.SabbathSchool, () => sabbathSchoolMain),
    Match.when(Command.EldersDigest, () => eldersDigestMain),
    Match.exhaustive,
  );
}).pipe(
  Effect.provide(
    Layer.mergeAll(
      Layer.provideMerge(
        CommandService.Default,
        Layer.provideMerge(ModelService.Default, ParseService.Default),
      ),
      BunFileSystem.layer,
    ),
  ),
);

BunRuntime.runMain(main);
