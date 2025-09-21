import * as path from 'path';

import { confirm, isCancel, select, text } from '@clack/prompts';
import { FileSystem } from '@effect/platform';
import { generateText } from 'ai';
import { format } from 'date-fns';
import { Data, Effect, Layer, Match, Option, Schedule } from 'effect';
import { makeAppleNoteFromMarkdown } from 'lib/markdown-to-notes';

import { log } from '~/lib/log';
import { getNoteContent, listNotes } from '~/lib/notes-utils';

import { msToMinutes, spin } from '../lib';
import { ModelService } from '../model';
import { ParseService } from '../parse';
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

  const revisedStudy = yield* revise(study);

  return {
    filename: filename.text,
    study: Option.getOrElse(revisedStudy, () => study),
  };
});

const revise = Effect.fn('revise')(function* (study: string) {
  const models = yield* ModelService;
  const fs = yield* FileSystem.FileSystem;

  while (true) {
    yield* log.info('study: \n\n' + study);
    let shouldRevise = yield* Effect.tryPromise({
      try: () =>
        confirm({
          message: 'Should the study be revised?',
          initialValue: false,
        }),
      catch: (cause: unknown) =>
        new PromptError({
          cause,
        }),
    });

    if (isCancel(shouldRevise) || !shouldRevise) {
      return Option.none<string>();
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
      return Option.none<string>();
    }

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
                content: userRevisePrompt(study, revisions),
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

    shouldRevise = yield* Effect.tryPromise({
      try: () =>
        confirm({
          message: 'Should the study be revised further?',
          initialValue: false,
        }),
      catch: (cause: unknown) =>
        new PromptError({
          cause,
        }),
    });

    if (isCancel(shouldRevise) || shouldRevise) {
      return Option.some(reviseResponse.text);
    }
  }
});

const generateStudy = Effect.gen(function* (_) {
  const startTime = Date.now();
  const args = yield* Args;

  const topic = yield* Option.match(args.topic, {
    onSome: (topic) => Effect.succeed(topic),
    onNone: () =>
      Effect.tryPromise({
        try: () =>
          text({
            message: 'What would you like the study to be about?',
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

  const { filename, study } = yield* generate(topic);

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
});

const reviseMessage = Effect.gen(function* (_) {
  const fs = yield* FileSystem.FileSystem;

  const studiesDir = path.join(process.cwd(), 'outputs', 'studies');
  const files = yield* fs.readDirectory(studiesDir);

  const filePaths = files.map((file) => path.join(studiesDir, file));

  const filePath = yield* Effect.tryPromise({
    try: () =>
      select({
        message: 'Which study would you like to revise?',
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

  const study = yield* fs.readFile(filePath);

  const revisedStudy = yield* revise(new TextDecoder().decode(study));

  if (Option.isNone(revisedStudy)) {
    return;
  }

  yield* fs.writeFile(filePath, new TextEncoder().encode(revisedStudy.value));
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

  const { filename, study } = yield* generate(note);

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
});

const program = Effect.gen(function* () {
  const { action } = yield* ActionService;

  return yield* Match.value(action).pipe(
    Match.when(Actions.Generate, () => generateStudy),
    Match.when(Actions.GenerateFromNote, () => generateFromNoteMessage),
    Match.when(Actions.Revise, () => reviseMessage),
    Match.exhaustive,
  );
});

export const main = program.pipe(
  Effect.provide(Layer.mergeAll(ActionService.Default, Args.Default)),
);
