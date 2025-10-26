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

const generateStudy = Command.make('generate', { topic, model }, (args) =>
  Effect.gen(function* (_) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const startTime = Date.now();

    const topic = yield* Option.match(args.topic, {
      onSome: (topic) => Effect.succeed(topic),
      onNone: () =>
        text({
          message: 'What would you like the study to be about?',
        }),
    });

    yield* Effect.log(`topic: ${topic}`);

    const systemPrompt = yield* fs
      .readFile(
        path.join(process.cwd(), 'core', 'studies', 'prompts', 'generate.md'),
      )
      .pipe(Effect.map((i) => new TextDecoder().decode(i)));

    const { filename, response } = yield* generate(systemPrompt, topic).pipe(
      Effect.provideService(Model, args.model),
    );

    const studiesDir = path.join(process.cwd(), 'outputs', 'studies');

    const fileName = `${format(new Date(), 'yyyy-MM-dd')}-${filename}.md`;
    const filePath = path.join(studiesDir, fileName);

    yield* spin(
      'Ensuring studies directory exists',
      fs.makeDirectory(studiesDir).pipe(Effect.ignore),
    );

    yield* spin(
      'Writing study to file: ' + fileName,
      fs.writeFile(filePath, new TextEncoder().encode(response)),
    );

    yield* spin('Adding study to notes', makeAppleNoteFromMarkdown(response));

    const totalTime = msToMinutes(Date.now() - startTime);
    yield* Effect.log(
      `Study generated successfully! (Total time: ${totalTime})`,
    );
  }),
);

const reviseMessage = Command.make('revise', { model }, (args) =>
  Effect.gen(function* (_) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;

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

    const study = yield* fs
      .readFile(filePath)
      .pipe(Effect.map((i) => new TextDecoder().decode(i)));

    const systemMessagePrompt = yield* fs
      .readFile(
        path.join(process.cwd(), 'core', 'studies', 'prompts', 'generate.md'),
      )
      .pipe(Effect.map((i) => new TextDecoder().decode(i)));

    const revisedStudy = yield* revise({
      cycles: [
        {
          prompt: '',
          response: study,
        },
      ],
      systemPrompt: systemMessagePrompt,
    }).pipe(Effect.provideService(Model, args.model));

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
    const path = yield* Path.Path;

    const startTime = Date.now();

    const note = yield* getNote;

    const systemPrompt = yield* fs
      .readFile(
        path.join(process.cwd(), 'core', 'studies', 'prompts', 'generate.md'),
      )
      .pipe(Effect.map((i) => new TextDecoder().decode(i)));

    const { filename, response } = yield* generate(systemPrompt, note).pipe(
      Effect.provideService(Model, args.model),
    );

    const studiesDir = path.join(process.cwd(), 'outputs', 'studies');

    const fileName = `${format(new Date(), 'yyyy-MM-dd')}-${filename}.md`;
    const filePath = path.join(studiesDir, fileName);

    yield* spin(
      'Writing study to file: ' + fileName,
      fs.writeFile(filePath, new TextEncoder().encode(response)),
    );

    yield* spin('Adding message to notes', makeAppleNoteFromMarkdown(response));

    const totalTime = msToMinutes(Date.now() - startTime);
    yield* Effect.log(
      `Study generated successfully! (Total time: ${totalTime})`,
    );
  }),
);

export const studies = Command.make('studies').pipe(
  Command.withSubcommands([
    generateStudy,
    reviseMessage,
    generateFromNoteMessage,
  ]),
);
