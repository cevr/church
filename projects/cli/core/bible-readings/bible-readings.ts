import { Command } from '@effect/cli';
import { FileSystem, Path } from '@effect/platform';
import { Effect } from 'effect';

import { generate } from '~/lib/generate';

import { msToMinutes, spin } from '../../lib/general';
import { Model, model } from '../model';

const processChapters = Command.make('process', { model }, (args) =>
  Effect.gen(function* (_) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const startTime = Date.now();

    // Path to extracted chapters directory
    const chaptersDir = path.join(
      process.cwd(),
      '..',
      'scripts',
      'extracted-chapters',
    );

    // Path to output directory
    const outputDir = path.join(process.cwd(), 'outputs', 'bible-readings');

    // Ensure output directory exists
    yield* spin(
      'Ensuring output directory exists',
      fs.makeDirectory(outputDir).pipe(Effect.ignore),
    );

    // Read the system prompt
    const systemPrompt = yield* fs
      .readFile(
        path.join(
          process.cwd(),
          'core',
          'bible-readings',
          'prompts',
          'generate.md',
        ),
      )
      .pipe(Effect.map((i) => new TextDecoder().decode(i)));

    // Get all chapter files
    const files = yield* fs.readDirectory(chaptersDir);

    // Filter to only chapter files and sort them
    const chapterFiles = files
      .filter((file) => file.startsWith('chapter-') && file.endsWith('.txt'))
      .sort((a, b) => {
        // Extract chapter numbers and compare
        const numA = parseInt(a.match(/chapter-(\d+)\.txt/)?.[1] || '0', 10);
        const numB = parseInt(b.match(/chapter-(\d+)\.txt/)?.[1] || '0', 10);
        return numA - numB;
      });

    yield* Effect.log(`Found ${chapterFiles.length} chapter files to process`);

    // Filter chapters that haven't been processed yet
    const chaptersToProcess = yield* Effect.filter(
      chapterFiles,
      (chapterFile) =>
        Effect.gen(function* () {
          const chapterNum =
            chapterFile.match(/chapter-(\d+)\.txt/)?.[1] || '0';
          const outputFile = path.join(outputDir, `chapter-${chapterNum}.md`);
          const exists = yield* fs.exists(outputFile);
          return !exists;
        }),
      {
        concurrency: 'unbounded',
      },
    );

    if (chaptersToProcess.length === 0) {
      yield* Effect.log('All chapters have already been processed!');
      return;
    }

    yield* Effect.log(
      `Processing ${chaptersToProcess.length} chapters (${chapterFiles.length - chaptersToProcess.length} already completed)`,
    );

    // Process each chapter
    yield* Effect.forEach(
      chaptersToProcess,
      (chapterFile, index) =>
        Effect.gen(function* () {
          const chapterNum =
            chapterFile.match(/chapter-(\d+)\.txt/)?.[1] || '0';
          const chapterPath = path.join(chaptersDir, chapterFile);

          yield* Effect.log(
            `[${index + 1}/${chaptersToProcess.length}] Processing ${chapterFile}...`,
          );

          // Read chapter content
          const chapterContent = yield* fs
            .readFile(chapterPath)
            .pipe(Effect.map((i) => new TextDecoder().decode(i)));

          // Generate study from chapter
          const { response } = yield* generate(
            systemPrompt,
            chapterContent,
          ).pipe(Effect.provideService(Model, args.model));

          // Write output
          const outputFile = path.join(outputDir, `chapter-${chapterNum}.md`);
          yield* spin(
            `Writing ${chapterFile} to ${outputFile}`,
            fs.writeFile(outputFile, new TextEncoder().encode(response)),
          );

          yield* Effect.log(`✓ Completed ${chapterFile}`);
        }).pipe(
          Effect.annotateLogs({
            chapter: chapterFile,
            current: index + 1,
            total: chaptersToProcess.length,
          }),
        ),
      {
        concurrency: 1, // Process one at a time to avoid rate limits
      },
    );

    const totalTime = msToMinutes(Date.now() - startTime);
    yield* Effect.log(
      `\n✅ All chapters processed successfully! (Total time: ${totalTime})`,
    );
  }),
);

export const bibleReadings = Command.make('bible-readings').pipe(
  Command.withSubcommands([processChapters]),
);
