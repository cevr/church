import { Command } from '@effect/cli';
import { select } from '@effect/cli/Prompt';
import { FileSystem, Path } from '@effect/platform';
import { BunContext, BunRuntime } from '@effect/platform-bun';
import { format } from 'date-fns';
import { Effect } from 'effect';

import { spin } from '~/lib/general';

const chooseDirectory = Effect.fn('chooseDirectory')(function* (
  baseDir: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const choose = Effect.fn('chooseDirectory.choose')(function* (dir: string) {
    const files = yield* fs.readDirectory(dir);
    const paths = files
      .map((file) => path.join(dir, file))
      .sort((a, b) => b.localeCompare(a));

    const directories = yield* Effect.filter(paths, (filePath) =>
      Effect.gen(function* () {
        const stat = yield* fs.stat(filePath);
        const isDirectory = stat.type === 'Directory';
        return isDirectory;
      }),
    );
    if (directories.length === 0) {
      return yield* Effect.dieMessage(`No directory selected in ${dir}`);
    }
    return directories;
  });

  const directories = yield* choose(baseDir);
  const selectedDirectory = yield* select({
    choices: directories.map((dir) => ({
      title: path.basename(dir),
      value: dir,
    })),
    message: 'Select a directory',
    maxPerPage: 10,
  });

  return selectedDirectory;
});

const command = Command.make('timestamp-output', {}, () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const baseDir = path.join(process.cwd(), 'outputs');
    const selectedDirectory = yield* chooseDirectory(baseDir);
    const files = yield* fs.readDirectory(selectedDirectory);
    const paths = files
      .map((file) => path.join(selectedDirectory, file))
      .sort((a, b) => b.localeCompare(a));
    yield* Effect.forEach(paths, (filePath) =>
      Effect.gen(function* () {
        const stat = yield* fs.stat(filePath);

        const created = yield* stat.birthtime;
        const baseName = path.basename(filePath);

        const yearRegex = /^(\d{4}-\d{2}-\d{2})-/;

        if (yearRegex.test(baseName)) {
          yield* Effect.log(`${baseName} already has a timestamp`);
          return;
        }

        const newTitle = `${format(created, 'yyyy-MM-dd')}-${baseName}`;

        yield* spin(
          `Renaming ${baseName} -> ${newTitle}`,
          fs.rename(filePath, path.join(path.dirname(filePath), newTitle)),
        );
      }),
    );
  }),
);

const cli = Command.run(command, {
  name: 'Timestamp Output',
  version: 'v1.0.0',
});

cli(process.argv).pipe(Effect.provide(BunContext.layer), BunRuntime.runMain);
