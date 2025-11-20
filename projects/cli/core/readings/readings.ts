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
    const outputDir = path.join(process.cwd(), 'outputs', 'readings');

    // Ensure output directory exists
    yield* spin(
      'Ensuring output directory exists',
      fs.makeDirectory(outputDir).pipe(Effect.ignore),
    );

    // Read the system prompts
    const studyPrompt = yield* fs
      .readFile(
        path.join(
          process.cwd(),
          'core',
          'readings',
          'prompts',
          'generate-study.md',
        ),
      )
      .pipe(Effect.map((i) => new TextDecoder().decode(i)));

    const slidesPrompt = yield* fs
      .readFile(
        path.join(
          process.cwd(),
          'core',
          'readings',
          'prompts',
          'generate-slides.md',
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
          const studyFile = path.join(
            outputDir,
            `chapter-${chapterNum}-study.md`,
          );
          const slidesFile = path.join(
            outputDir,
            `chapter-${chapterNum}-slides.md`,
          );
          const studyExists = yield* fs.exists(studyFile);
          const slidesExists = yield* fs.exists(slidesFile);
          return !studyExists || !slidesExists;
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
          const studyOutputFile = path.join(
            outputDir,
            `chapter-${chapterNum}-study.md`,
          );
          const slidesOutputFile = path.join(
            outputDir,
            `chapter-${chapterNum}-slides.md`,
          );

          yield* Effect.log(
            `[${index + 1}/${chaptersToProcess.length}] Processing ${chapterFile}...`,
          );

          const studyExists = yield* fs.exists(studyOutputFile);
          let studyContent = '';

          if (studyExists) {
            yield* Effect.log(
              `Study already exists for ${chapterFile}, skipping generation...`,
            );
            studyContent = yield* fs
              .readFile(studyOutputFile)
              .pipe(Effect.map((i) => new TextDecoder().decode(i)));
          } else {
            // Read chapter content
            const chapterContent = yield* fs
              .readFile(chapterPath)
              .pipe(Effect.map((i) => new TextDecoder().decode(i)));

            // Generate study from chapter
            const { response } = yield* generate(studyPrompt, chapterContent, {
              skipRevisions: true,
              skipChime: true,
            }).pipe(Effect.provideService(Model, args.model));
            studyContent = response;

            // Write output
            yield* spin(
              `Writing study to ${studyOutputFile}`,
              fs.writeFile(
                studyOutputFile,
                new TextEncoder().encode(studyContent),
              ),
            );
          }

          const slidesExists = yield* fs.exists(slidesOutputFile);
          if (!slidesExists) {
            // Generate slides from study
            const { response: slidesContent } = yield* generate(
              slidesPrompt,
              studyContent,
              { skipRevisions: true, skipChime: true },
            ).pipe(Effect.provideService(Model, args.model));

            // Write output
            yield* spin(
              `Writing slides to ${slidesOutputFile}`,
              fs.writeFile(
                slidesOutputFile,
                new TextEncoder().encode(slidesContent),
              ),
            );
          }

          yield* Effect.log(
            `[${index + 1}/${chaptersToProcess.length}] ✓ Completed ${chapterFile}`,
          );
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

export const readings = Command.make('readings').pipe(
  Command.withSubcommands([processChapters]),
);
