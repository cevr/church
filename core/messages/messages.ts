import * as path from 'path';

import { confirm, isCancel, select, text } from '@clack/prompts';
import { Command, Options } from '@effect/cli';
import { FileSystem } from '@effect/platform';
import { generateText } from 'ai';
import { format } from 'date-fns';
import { Data, Effect, Option, Schedule } from 'effect';
import { makeAppleNoteFromMarkdown } from 'lib/markdown-to-notes';

import { log } from '~/lib/log';
import { getNoteContent, listNotes } from '~/lib/notes-utils';

import { msToMinutes, spin } from '../lib';
import { Model, model } from '../model';
import { userRevisePrompt } from './prompts/prompts';

class PromptError extends Data.TaggedError('PromptError')<{
  cause: unknown;
}> {}

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

  let revision: string | undefined;

  yield* log.info('message: \n\n' + message);
  while (true) {
    let shouldRevise = yield* Effect.tryPromise({
      try: () =>
        confirm({
          message: 'Should the message be revised?',
          initialValue: false,
        }),
      catch: (cause: unknown) =>
        new PromptError({
          cause,
        }),
    });

    if (isCancel(shouldRevise) || !shouldRevise) {
      return Option.fromNullable(revision);
    }

    const revisions = yield* Effect.tryPromise({
      try: () =>
        text({
          message: 'What are the revisions to be made?',
        }),
      catch: (cause: unknown) =>
        new PromptError({
          cause,
        }),
    });

    if (isCancel(revisions)) {
      return Option.fromNullable(revision);
    }

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

    yield* log.info(`reviseResponse: ${reviseResponse.text}`);
    revision = reviseResponse.text;
  }
});

const topic = Options.text('topic').pipe(
  Options.withAlias('t'),
  Options.optional,
);

const generateMessage = Command.make('generate', { topic, model }, (args) =>
  Effect.gen(function* (_) {
    const startTime = Date.now();

    const topic = yield* Option.match(args.topic, {
      onSome: (topic) => Effect.succeed(topic),
      onNone: () =>
        Effect.tryPromise({
          try: () =>
            text({
              message: 'What would you like the message to be about?',
              placeholder: 'e.g., The Power of Prayer',
            }),
          catch: (cause: unknown) =>
            new PromptError({
              cause,
            }),
        }),
    });

    if (isCancel(topic)) {
      yield* Effect.dieMessage('Operation cancelled.');
      return;
    }

    yield* log.info(`topic: ${topic}`);

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
    yield* log.success(
      `Message generated successfully! (Total time: ${totalTime})`,
    );
  }),
);

const reviseMessage = Command.make('revise', { model }, (args) =>
  Effect.gen(function* (_) {
    const fs = yield* FileSystem.FileSystem;

    const messagesDir = path.join(process.cwd(), 'outputs', 'messages');
    const files = yield* fs.readDirectory(messagesDir);

    const filePaths = files.map((file) => path.join(messagesDir, file));

    const filePath = yield* Effect.tryPromise({
      try: () =>
        select({
          message: 'Which message would you like to revise?',
          options: filePaths.map((filePath) => ({
            label: path.basename(filePath),
            value: filePath,
          })),
          maxItems: 5,
        }),
      catch: (cause: unknown) =>
        new PromptError({
          cause,
        }),
    });

    if (isCancel(filePath)) {
      yield* Effect.dieMessage('Operation cancelled.');
      return;
    }

    const message = yield* fs.readFile(filePath);

    const revisedMessage = yield* revise(
      '',
      new TextDecoder().decode(message),
    ).pipe(Effect.provideService(Model, args.model));

    if (Option.isNone(revisedMessage)) {
      yield* log.error('No message to revise.');
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

  const noteId = yield* Effect.tryPromise({
    try: () =>
      select({
        message: 'Which note would you like to generate a message from?',
        options: notes.map((note) => ({
          label: note.name,
          value: note.id,
        })),
        maxItems: 5,
      }),
    catch: (cause: unknown) =>
      new PromptError({
        cause,
      }),
  });

  if (isCancel(noteId)) {
    return yield* Effect.dieMessage('Operation cancelled.');
  }

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
      yield* log.success(
        `Message generated successfully! (Total time: ${totalTime})`,
      );
    }),
);

export const messages = Command.make('messages', {}, () =>
  log.info('messages'),
).pipe(
  Command.withSubcommands([
    //
    generateMessage,
    reviseMessage,
    generateFromNoteMessage,
  ]),
);
