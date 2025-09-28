import path from 'node:path';

import { isCancel, multiselect, select } from '@clack/prompts';
import { Command } from '@effect/cli';
import { FileSystem } from '@effect/platform';
import type { PlatformError } from '@effect/platform/Error';
import { Data, Effect } from 'effect';

import { makeAppleNoteFromMarkdown } from '~/lib/markdown-to-notes';

class ArgsError extends Data.TaggedError('ArgsError')<{
  message: string;
}> {}

const selectDirectory = Effect.fn('selectDirectory')(function* (
  filepath: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const files = yield* fileSystem.readDirectory(filepath);
  const paths = files
    .map((file) => path.join(filepath, file))
    .sort((a, b) => a.localeCompare(b));
  const options = yield* Effect.forEach(
    paths,
    (filePath) =>
      Effect.gen(function* () {
        const stat = yield* fileSystem.stat(filePath);
        const isDirectory = stat.type === 'Directory';
        return {
          label: `${path.basename(filePath)} (${
            isDirectory ? 'directory' : 'file'
          })`,
          value: filePath,
        };
      }),
    {
      concurrency: 'unbounded',
    },
  );
  const selectedPath = yield* Effect.tryPromise({
    try: () =>
      select({
        message: 'Select a file',
        options,
        maxItems: 10,
      }),
    catch: () => new ArgsError({ message: 'No file selected' }),
  });
  if (isCancel(selectedPath)) {
    return yield* Effect.dieMessage('No file selected');
  }
  return selectedPath;
});

const chooseFiles = (
  filepath: string,
): Effect.Effect<string[], ArgsError | PlatformError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const stat = yield* fileSystem.stat(filepath);
    const isDirectory = stat.type === 'Directory';

    if (!isDirectory) {
      return yield* Effect.dieMessage('Not a directory');
    }

    const files = yield* fileSystem.readDirectory(filepath);
    const paths = files
      .map((file) => path.join(filepath, file))
      .sort((a, b) => a.localeCompare(b))
      .filter((path) => path.endsWith('.md'));

    const selectedFiles = yield* Effect.tryPromise({
      try: () =>
        multiselect({
          message: 'Select files',
          options: paths.map((p) => ({
            label: path.basename(p),
            value: p,
          })),
        }),
      catch: () => new ArgsError({ message: 'No file selected' }),
    });

    if (isCancel(selectedFiles)) {
      return yield* Effect.dieMessage('No file selected');
    }

    return selectedFiles;
  });

export const exportOutput = Command.make('export-output', {}, () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;

    const selectedDirectory = yield* selectDirectory(
      path.join(process.cwd(), 'outputs'),
    );

    const selectedFiles = yield* chooseFiles(selectedDirectory);

    const contents = yield* Effect.forEach(selectedFiles, (filePath) =>
      fileSystem.readFile(filePath),
    );

    yield* Effect.forEach(contents, (content) =>
      makeAppleNoteFromMarkdown(new TextDecoder().decode(content)),
    );
  }),
);
