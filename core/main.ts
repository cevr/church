import { Command } from '@effect/cli';
import { BunContext, BunRuntime } from '@effect/platform-bun';
import { Effect } from 'effect';

import { messages } from './messages/messages';
import { sabbathSchool } from './sabbath-school/sabbath-school';
import { studies } from './studies/studies';

// Combine all commands into the main 'minigit' command
const command = Command.make('church-tools', {}).pipe(
  Command.withSubcommands([messages, sabbathSchool, studies]),
);

// Initialize and run the CLI application
const cli = Command.run(command, {
  name: 'Church Tools',
  version: 'v1.0.0',
});


cli(process.argv).pipe(Effect.provide(BunContext.layer), BunRuntime.runMain);
