import * as path from 'path';

import { Args, Command } from '@effect/cli';
import { confirm, select, text } from '@effect/cli/Prompt';
import { FileSystem } from '@effect/platform';
import { generateText } from 'ai';
import { format } from 'date-fns';
import { Data, Effect, Option, Schedule } from 'effect';
import { makeAppleNoteFromMarkdown } from 'lib/markdown-to-notes';

import { log } from '~/lib/log';
import { getNoteContent, listNotes } from '~/lib/notes-utils';

import { msToMinutes, spin } from '../lib';
import { Model, model } from '../model';
import { userRevisePrompt } from './prompts/revise';

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
      path.join(process.cwd(), 'core', 'studies', 'prompts', 'generate.md'),
    )
    .pipe(Effect.map((i) => new TextDecoder().decode(i)));

  const response = yield* spin(
    'Generating study outline',
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

  const study = response.text;

  const filename = yield* Effect.tryPromise({
    try: () =>
      generateText({
        model: models.low,
        messages: [
          {
            role: 'system',
            content:
              'Generate a filename for the following SDA bible study. Kebab case. No extension. IMPORTANT: Only the filename, no other text. eg: christ-in-me-the-hope-of-glory',
          },
          { role: 'user', content: study },
        ],
      }),
    catch: (cause: unknown) =>
      new FilenameError({
        cause,
      }),
  });

  const revisedStudy = yield* revise(topic, study);

  return {
    filename: filename.text,
    study: Option.getOrElse(revisedStudy, () => study),
  };
});

const revise = Effect.fn('revise')(function* (prompt: string, study: string) {
  const models = yield* Model;
  const fs = yield* FileSystem.FileSystem;

  let revision: string | undefined;

  yield* log.info('study: \n\n' + study);
  while (true) {
    let shouldRevise = yield* confirm({
      message: 'Should the study be revised?',
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
        path.join(process.cwd(), 'core', 'studies', 'prompts', 'generate.md'),
      )
      .pipe(Effect.map((i) => new TextDecoder().decode(i)));

    const reviseResponse = yield* spin(
      'Revising study',
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
                content: userRevisePrompt(prompt, study, revisions),
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

const topic = Args.text({
  name: 'topic',
}).pipe(Args.optional);

const generateStudy = Command.make('generate', { topic, model }, (args) =>
  Effect.gen(function* (_) {
    const startTime = Date.now();

    const topic = yield* Option.match(args.topic, {
      onSome: (topic) => Effect.succeed(topic),
      onNone: () =>
        text({
          message: 'What would you like the study to be about?',
        }),
    });

    yield* log.info(`topic: ${topic}`);

    const { filename, study } = yield* generate(topic).pipe(
      Effect.provideService(Model, args.model),
    );

    const studiesDir = path.join(process.cwd(), 'outputs', 'studies');

    const fileName = `${format(new Date(), 'yyyy-MM-dd')}-${filename}.md`;
    const filePath = path.join(studiesDir, fileName);

    const fs = yield* FileSystem.FileSystem;

    yield* spin(
      'Ensuring studies directory exists',
      fs.makeDirectory(studiesDir).pipe(Effect.ignore),
    );

    yield* spin(
      'Writing study to file: ' + fileName,
      fs.writeFile(filePath, new TextEncoder().encode(study)),
    );

    yield* spin('Adding study to notes', makeAppleNoteFromMarkdown(study));

    const totalTime = msToMinutes(Date.now() - startTime);
    yield* log.success(
      `Study generated successfully! (Total time: ${totalTime})`,
    );
  }),
);

const reviseMessage = Command.make('revise', { model }, (args) =>
  Effect.gen(function* (_) {
    const fs = yield* FileSystem.FileSystem;

    const studiesDir = path.join(process.cwd(), 'outputs', 'studies');
    const files = yield* fs.readDirectory(studiesDir);

    const filePaths = files
      .map((file) => path.join(studiesDir, file))
      .sort((a, b) => a.localeCompare(b));

    const filePath = yield* select({
      message: 'Which study would you like to revise?',
      choices: filePaths.map((filePath) => ({
        title: path.basename(filePath),
        value: filePath,
      })),
      maxPerPage: 5,
    });

    const study = yield* fs.readFile(filePath);

    const revisedStudy = yield* revise(
      '',
      new TextDecoder().decode(study),
    ).pipe(Effect.provideService(Model, args.model));

    if (Option.isNone(revisedStudy)) {
      return;
    }

    yield* fs.writeFile(filePath, new TextEncoder().encode(revisedStudy.value));
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

const generateFromNoteMessage = Command.make('from-note', { model }, (args) =>
  Effect.gen(function* (_) {
    const fs = yield* FileSystem.FileSystem;
    const startTime = Date.now();

    const note = yield* getNote;

    const { filename, study } = yield* generate(note).pipe(
      Effect.provideService(Model, args.model),
    );

    const studiesDir = path.join(process.cwd(), 'outputs', 'studies');

    const fileName = `${format(new Date(), 'yyyy-MM-dd')}-${filename}.md`;
    const filePath = path.join(studiesDir, fileName);

    yield* spin(
      'Writing study to file: ' + fileName,
      fs.writeFile(filePath, new TextEncoder().encode(study)),
    );

    yield* spin('Adding message to notes', makeAppleNoteFromMarkdown(study));

    const totalTime = msToMinutes(Date.now() - startTime);
    yield* log.success(
      `Study generated successfully! (Total time: ${totalTime})`,
    );
  }),
);

export const studies = Command.make('studies').pipe(
  Command.withSubcommands([
    //
    generateStudy,
    reviseMessage,
    generateFromNoteMessage,
  ]),
);
