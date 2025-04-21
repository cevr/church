import * as path from 'path';

import { isCancel, select, text } from '@clack/prompts';
import { FileSystem } from '@effect/platform';
import { generateText } from 'ai';
import { format } from 'date-fns';
import dotenv from 'dotenv';
import { Data, Effect, Match, Option, Schedule } from 'effect';
import { makeAppleNoteFromMarkdown } from 'lib/markdown-to-notes';

import { log } from '~/lib/log';
import { getNoteContent, listNotes } from '~/lib/notes-utils';

import { msToMinutes, spin } from '../lib';
import { ModelService } from '../model';
import { ParseService } from '../parse';
import { userRevisePrompt } from './prompts/prompts';

dotenv.config();

class PromptError extends Data.TaggedError('PromptError')<{
  cause: unknown;
}> {}

class OutlineError extends Data.TaggedError('OutlineError')<{
  cause: unknown;
}> {}

class ReviewError extends Data.TaggedError('ReviewError')<{
  cause: unknown;
}> {}

class ReviseError extends Data.TaggedError('ReviseError')<{
  cause: unknown;
}> {}

class FilenameError extends Data.TaggedError('FilenameError')<{
  cause: unknown;
}> {}

enum Actions {
  Generate = 'generate',
  GenerateFromNote = 'generate-from-note',
  Revise = 'revise',
}

class ActionService extends Effect.Service<ActionService>()('Action', {
  effect: Effect.gen(function* () {
    const parse = yield* ParseService;
    let action = yield* parse.command(Actions, {
      message: 'What would you like to do?',
      labels: {
        [Actions.Generate]: 'Generate',
        [Actions.GenerateFromNote]: 'Generate from note',
        [Actions.Revise]: 'Revise',
      },
    });

    return {
      action,
    };
  }),
}) {}

class Args extends Effect.Service<Args>()('Args', {
  effect: Effect.gen(function* () {
    const parse = yield* ParseService;
    const topic = parse.flag(['topic', 't']);
    return { topic };
  }),
}) {}

export const generate = Effect.fn('generate')(function* (topic: string) {
  const models = yield* ModelService;
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

  const revisedMessage = yield* revise(message);

  return {
    filename: filename.text,
    message: Option.getOrElse(revisedMessage, () => message),
  };
});

const revise = Effect.fn('revise')(function* (message: string) {
  const models = yield* ModelService;
  const fs = yield* FileSystem.FileSystem;

  const systemReviewPrompt = yield* fs
    .readFile(
      path.join(process.cwd(), 'core', 'messages', 'prompts', 'review.md'),
    )
    .pipe(Effect.map((i) => new TextDecoder().decode(i)));

  const reviewResponse = yield* spin(
    'Reviewing message',
    Effect.tryPromise({
      try: () =>
        generateText({
          model: models.high,
          // schema: z.object({
          //   needsRevision: z
          //     .boolean()
          //     .describe('Whether the message needs revision'),
          //   revisions: z
          //     .array(z.string())
          //     .describe('The specific criteria that need revision'),
          // }),
          messages: [
            {
              role: 'system',
              content: systemReviewPrompt,
            },
            {
              role: 'user',
              content: message,
            },
          ],
        }),
      catch: (cause: unknown) =>
        new ReviewError({
          cause,
        }),
    }),
  );

  const needsRevision = reviewResponse.text.includes('YES');

  yield* log.info(`needsRevision: ${needsRevision}`);

  if (!needsRevision) {
    return Option.none<string>();
  }

  const matchedRevisions = reviewResponse.text.match(
    /<REVISION_FEEDBACK>(.*?)<\/REVISION_FEEDBACK>/,
  );
  const revisions =
    matchedRevisions?.[1]?.split('\n').map((i) => i.trim()) ?? [];

  const systemRevisePrompt = yield* fs
    .readFile(
      path.join(process.cwd(), 'core', 'messages', 'prompts', 'revise.md'),
    )
    .pipe(Effect.map((i) => new TextDecoder().decode(i)));

  const revisedMessage = yield* spin(
    'Revising message',
    Effect.tryPromise({
      try: () =>
        generateText({
          model: models.high,
          messages: [
            {
              role: 'system',
              content: systemRevisePrompt,
            },
            {
              role: 'user',
              content: userRevisePrompt(message, revisions),
            },
          ],
        }),
      catch: (cause: unknown) =>
        new ReviseError({
          cause,
        }),
    }),
  );

  return Option.some(revisedMessage.text);
});

const generateMessage = Effect.gen(function* (_) {
  const startTime = Date.now();
  const args = yield* Args;

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

  const { filename, message } = yield* generate(topic);

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
});

const reviseMessage = Effect.gen(function* (_) {
  const fs = yield* FileSystem.FileSystem;
  const startTime = Date.now();

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

  const revisedMessage = yield* revise(new TextDecoder().decode(message));

  if (Option.isNone(revisedMessage)) {
    yield* log.error('No message to revise.');
    return;
  }

  yield* fs.writeFile(filePath, new TextEncoder().encode(revisedMessage.value));
});

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

const generateFromNoteMessage = Effect.gen(function* (_) {
  const fs = yield* FileSystem.FileSystem;
  const startTime = Date.now();

  const note = yield* getNote;

  const { filename, message } = yield* generate(note);

  const messagesDir = path.join(process.cwd(), 'outputs', 'messages');

  const fileName = `${format(new Date(), 'yyyy-MM-dd')}-${filename}.md`;
  const filePath = path.join(messagesDir, fileName);

  yield* spin(
    'Writing message to file: ' + fileName,
    fs.writeFile(filePath, new TextEncoder().encode(message)),
  );

  yield* spin('Adding message to notes', makeAppleNoteFromMarkdown(message));

  const totalTime = msToMinutes(Date.now() - startTime);
  yield* log.success(
    `Message generated successfully! (Total time: ${totalTime})`,
  );
});

const program = Effect.gen(function* () {
  const { action } = yield* ActionService;

  return yield* Match.value(action).pipe(
    Match.when(Actions.Generate, () => generateMessage),
    Match.when(Actions.GenerateFromNote, () => generateFromNoteMessage),
    Match.when(Actions.Revise, () => reviseMessage),
    Match.exhaustive,
  );
});

export const main = program.pipe(
  Effect.provide(ActionService.Default),
  Effect.provide(Args.Default),
);
