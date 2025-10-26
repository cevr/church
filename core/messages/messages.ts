import { Args, Command } from '@effect/cli';
import { select, text } from '@effect/cli/Prompt';
import { FileSystem, Path } from '@effect/platform';
import { format } from 'date-fns';
import { Effect, Option } from 'effect';

import { generate } from '~/lib/generate';
import { makeAppleNoteFromMarkdown } from '~/lib/markdown-to-notes';
import { getNoteContent, listNotes } from '~/lib/notes-utils';
import { revise } from '~/lib/revise';

import { msToMinutes, spin } from '../../lib/general';
import { Model, model } from '../model';

const topic = Args.text({
  name: 'topic',
}).pipe(Args.optional);

const generateMessage = Command.make('generate', { topic, model }, (args) =>
  Effect.gen(function* (_) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const startTime = Date.now();

    const topic = yield* Option.match(args.topic, {
      onSome: (topic) => Effect.succeed(topic),
      onNone: () =>
        text({
          message: 'What would you like the message to be about?',
        }),
    });

    yield* Effect.log(`topic: ${topic}`);

    const systemPrompt = yield* fs
      .readFile(
        path.join(process.cwd(), 'core', 'messages', 'prompts', 'generate.md'),
      )
      .pipe(Effect.map((i) => new TextDecoder().decode(i)));

    const { filename, response } = yield* generate(systemPrompt, topic).pipe(
      Effect.provideService(Model, args.model),
    );

    const messagesDir = path.join(process.cwd(), 'outputs', 'messages');

    const fileName = `${format(new Date(), 'yyyy-MM-dd')}-${filename}.md`;
    const filePath = path.join(messagesDir, fileName);

    yield* spin(
      'Ensuring messages directory exists',
      fs.makeDirectory(messagesDir).pipe(Effect.ignore),
    );

    yield* spin(
      'Writing message to file: ' + fileName,
      fs.writeFile(filePath, new TextEncoder().encode(response)),
    );

    yield* spin('Adding message to notes', makeAppleNoteFromMarkdown(response));

    const totalTime = msToMinutes(Date.now() - startTime);
    yield* Effect.log(
      `Message generated successfully! (Total time: ${totalTime})`,
    );
  }),
);

const reviseMessage = Command.make('revise', { model }, (args) =>
  Effect.gen(function* (_) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;

    const messagesDir = path.join(process.cwd(), 'outputs', 'messages');
    const files = yield* fs.readDirectory(messagesDir);

    const filePaths = files
      .map((file) => path.join(messagesDir, file))
      // most are named with the date (YYYY-MM-DD), so sort descending
      .sort((a, b) => b.localeCompare(a));

    const filePath = yield* select({
      message: 'Which message would you like to revise?',
      choices: filePaths.map((filePath) => ({
        title: path.basename(filePath),
        value: filePath,
      })),
      maxPerPage: 5,
    });

    const message = yield* fs
      .readFile(filePath)
      .pipe(Effect.map((i) => new TextDecoder().decode(i)));
    const systemMessagePrompt = yield* fs
      .readFile(
        path.join(process.cwd(), 'core', 'messages', 'prompts', 'generate.md'),
      )
      .pipe(Effect.map((i) => new TextDecoder().decode(i)));

    const revisedMessage = yield* revise({
      cycles: [
        {
          prompt: '',
          response: message,
        },
      ],
      systemPrompt: systemMessagePrompt,
    }).pipe(Effect.provideService(Model, args.model));

    if (Option.isNone(revisedMessage)) {
      yield* Effect.logError('No message to revise.');
      return;
    }

    yield* fs.writeFile(
      filePath,
      new TextEncoder().encode(revisedMessage.value),
    );
  }),
);

const getNote = Effect.gen(function* (_) {
  const notes = yield* listNotes();

  const noteId = yield* select({
    message: 'Which note would you like to generate a message from?',
    choices: notes.map((note) => ({
      title: note.name,
      value: note.id,
    })),
    maxPerPage: 5,
  });

  return yield* getNoteContent(noteId);
});

const generateFromNoteMessage = Command.make(
  'from-note',
  {
    model,
  },
  (args) =>
    Effect.gen(function* (_) {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const startTime = Date.now();
      const note = yield* getNote;

      const systemPrompt = yield* fs
        .readFile(
          path.join(
            process.cwd(),
            'core',
            'messages',
            'prompts',
            'generate.md',
          ),
        )
        .pipe(Effect.map((i) => new TextDecoder().decode(i)));

      const { filename, response } = yield* generate(systemPrompt, note).pipe(
        Effect.provideService(Model, args.model),
      );

      const messagesDir = path.join(process.cwd(), 'outputs', 'messages');

      const fileName = `${format(new Date(), 'yyyy-MM-dd')}-${filename}.md`;
      const filePath = path.join(messagesDir, fileName);

      yield* spin(
        'Writing message to file: ' + fileName,
        fs.writeFile(filePath, new TextEncoder().encode(response)),
      );

      yield* spin(
        'Adding message to notes',
        makeAppleNoteFromMarkdown(response),
      );

      const totalTime = msToMinutes(Date.now() - startTime);
      yield* Effect.log(
        `Message generated successfully! (Total time: ${totalTime})`,
      );
    }),
);

export const messages = Command.make('messages').pipe(
  Command.withSubcommands([
    generateMessage,
    reviseMessage,
    generateFromNoteMessage,
  ]),
);
