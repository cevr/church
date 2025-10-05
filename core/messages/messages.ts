import { Args, Command } from '@effect/cli';
import { confirm, select, text } from '@effect/cli/Prompt';
import { FileSystem, Path } from '@effect/platform';
import { generateText } from 'ai';
import { format } from 'date-fns';
import { Data, Effect, Option, Schedule } from 'effect';

import { makeAppleNoteFromMarkdown } from '~/prelude/markdown-to-notes';
import { getNoteContent, listNotes } from '~/prelude/notes-utils';

import { msToMinutes, spin } from '../../prelude/general';
import { Model, model } from '../model';
import { userRevisePrompt } from './prompts/revise';

class OutlineError extends Data.TaggedError('OutlineError')<{
  cause: unknown;
}> {}

class ReviewError extends Data.TaggedError('ReviewError')<{
  cause: unknown;
}> {}

class FilenameError extends Data.TaggedError('FilenameError')<{
  cause: unknown;
}> {}

export const generate = Effect.fn('generate')(function* (topic: string) {
  const models = yield* Model;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const systemMessagePrompt = yield* fs
    .readFile(
      path.join(process.cwd(), 'core', 'messages', 'prompts', 'generate.md'),
    )
    .pipe(Effect.map((i) => new TextDecoder().decode(i)));

  const response = yield* spin(
    'Generating message outline',
    Effect.tryPromise({
      try: () =>
        generateText({
          model: models.high,
          messages: [
            {
              role: 'system',
              content: systemMessagePrompt,
            },
            {
              role: 'user',
              content: topic,
            },
          ],
        }),
      catch: (cause: unknown) =>
        new OutlineError({
          cause,
        }),
    }).pipe(
      Effect.retry({
        times: 3,
        schedule: Schedule.spaced(500),
      }),
    ),
  );

  const message = response.text;

  const filename = yield* Effect.tryPromise({
    try: () =>
      generateText({
        model: models.low,
        messages: [
          {
            role: 'system',
            content:
              'Generate a filename for the following SDA bible study message. Kebab case. No extension. IMPORTANT: Only the filename, no other text. eg: christ-in-me-the-hope-of-glory',
          },
          { role: 'user', content: message },
        ],
      }),
    catch: (cause: unknown) =>
      new FilenameError({
        cause,
      }),
  });

  const revisedMessage = yield* revise(topic, message);

  return {
    filename: filename.text,
    message: Option.getOrElse(revisedMessage, () => message),
  };
});

const revise = Effect.fn('revise')(function* (prompt: string, message: string) {
  const models = yield* Model;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  let revision: string | undefined;

  yield* Effect.log('message: \n\n' + message);
  while (true) {
    let shouldRevise = yield* confirm({
      message: 'Should the message be revised?',
      initial: false,
    });

    if (!shouldRevise) {
      return Option.fromNullable(revision);
    }

    const revisions = yield* text({
      message: 'What are the revisions to be made?',
    });

    const systemPrompt = yield* fs
      .readFile(
        path.join(process.cwd(), 'core', 'messages', 'prompts', 'generate.md'),
      )
      .pipe(Effect.map((i) => new TextDecoder().decode(i)));

    const reviseResponse = yield* spin(
      'Revising message',
      Effect.tryPromise({
        try: () =>
          generateText({
            model: models.high,
            messages: [
              {
                role: 'system',
                content: systemPrompt,
              },
              {
                role: 'user',
                content: userRevisePrompt(prompt, message, revisions),
              },
            ],
          }),
        catch: (cause: unknown) =>
          new ReviewError({
            cause,
          }),
      }),
    );

    yield* Effect.log(`reviseResponse: ${reviseResponse.text}`);
    revision = reviseResponse.text;
  }
});

const topic = Args.text({
  name: 'topic',
}).pipe(Args.optional);

const generateMessage = Command.make('generate', { topic, model }, (args) =>
  Effect.gen(function* (_) {
    const startTime = Date.now();
    const path = yield* Path.Path;

    const topic = yield* Option.match(args.topic, {
      onSome: (topic) => Effect.succeed(topic),
      onNone: () =>
        text({
          message: 'What would you like the message to be about?',
        }),
    });

    yield* Effect.log(`topic: ${topic}`);

    const { filename, message } = yield* generate(topic).pipe(
      Effect.provideService(Model, args.model),
    );

    const messagesDir = path.join(process.cwd(), 'outputs', 'messages');

    const fileName = `${format(new Date(), 'yyyy-MM-dd')}-${filename}.md`;
    const filePath = path.join(messagesDir, fileName);

    const fs = yield* FileSystem.FileSystem;

    yield* spin(
      'Ensuring messages directory exists',
      fs.makeDirectory(messagesDir).pipe(Effect.ignore),
    );

    yield* spin(
      'Writing message to file: ' + fileName,
      fs.writeFile(filePath, new TextEncoder().encode(message)),
    );

    yield* spin('Adding message to notes', makeAppleNoteFromMarkdown(message));

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

    const message = yield* fs.readFile(filePath);

    const revisedMessage = yield* revise(
      '',
      new TextDecoder().decode(message),
    ).pipe(Effect.provideService(Model, args.model));

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

      const { filename, message } = yield* generate(note).pipe(
        Effect.provideService(Model, args.model),
      );

      const messagesDir = path.join(process.cwd(), 'outputs', 'messages');

      const fileName = `${format(new Date(), 'yyyy-MM-dd')}-${filename}.md`;
      const filePath = path.join(messagesDir, fileName);

      yield* spin(
        'Writing message to file: ' + fileName,
        fs.writeFile(filePath, new TextEncoder().encode(message)),
      );

      yield* spin(
        'Adding message to notes',
        makeAppleNoteFromMarkdown(message),
      );

      const totalTime = msToMinutes(Date.now() - startTime);
      yield* Effect.log(
        `Message generated successfully! (Total time: ${totalTime})`,
      );
    }),
);

export const messages = Command.make('messages').pipe(
  Command.withSubcommands([
    //
    generateMessage,
    reviseMessage,
    generateFromNoteMessage,
  ]),
);
