import { Command } from '@effect/cli';
import { multiSelect, select } from '@effect/cli/Prompt';
import { FileSystem, Path } from '@effect/platform';
import { Effect } from 'effect';

import { makeAppleNoteFromMarkdown } from '~/lib/markdown-to-notes';

const selectDirectory = Effect.fn('selectDirectory')(function* (
  filepath: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const files = yield* fileSystem.readDirectory(filepath);
  const paths = files
    .map((file) => path.join(filepath, file))
    .sort((a, b) => a.localeCompare(b));
  const choices = yield* Effect.forEach(
    paths,
    (filePath) =>
      Effect.gen(function* () {
        const stat = yield* fileSystem.stat(filePath);
        const isDirectory = stat.type === 'Directory';
        return {
          title: `${path.basename(filePath)} (${
            isDirectory ? 'directory' : 'file'
          })`,
          value: filePath,
        };
      }),
    {
      concurrency: 'unbounded',
    },
  );
  const selectedPath = yield* select({
    message: 'Select a file',
    choices,
    maxPerPage: 10,
  });
  return selectedPath;
});

const chooseFiles = Effect.fn('chooseFiles')(function* (filepath: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const stat = yield* fileSystem.stat(filepath);
  const isDirectory = stat.type === 'Directory';

  if (!isDirectory) {
    return yield* Effect.dieMessage('Not a directory');
  }

  const files = yield* fileSystem.readDirectory(filepath);
  const paths = files
    .map((file) => path.join(filepath, file))
    .sort((a, b) => b.localeCompare(a))
    .filter((path) => path.endsWith('.md'));

  const selectedFiles = yield* multiSelect({
    message: 'Select files',
    choices: paths.map((p) => ({
      title: path.basename(p),
      value: p,
    })),
  });

  return selectedFiles;
});

export const exportOutput = Command.make('export-output', {}, () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
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
