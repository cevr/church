import { Data, Effect, Option } from "effect";
import { FileSystem } from "@effect/platform";
import { isCancel, select } from "@clack/prompts";
import path from "node:path";
import type { PlatformError } from "@effect/platform/Error";
import { makeAppleNoteFromMarkdown } from "~/lib/markdown-to-notes";
import {} from "@effect/platform-node";
import { BunFileSystem, BunRuntime } from "@effect/platform-bun";

class ArgsError extends Data.TaggedError("ArgsError")<{
  message: string;
}> {}

const chooseFile = (
  filepath: string
): Effect.Effect<string, ArgsError | PlatformError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const stat = yield* fileSystem.stat(filepath);
    const isDirectory = stat.type === "Directory";

    if (isDirectory) {
      const files = yield* fileSystem.readDirectory(filepath);
      const paths = files.map((file) => path.join(filepath, file));
      const options = yield* Effect.forEach(
        paths,
        (filePath) =>
          Effect.gen(function* () {
            const stat = yield* fileSystem.stat(filePath);
            const isDirectory = stat.type === "Directory";
            return {
              label: `${path.basename(filePath)} (${
                isDirectory ? "directory" : "file"
              })`,
              value: filePath,
            };
          }),
        {
          concurrency: "unbounded",
        }
      );
      const selectedPath = yield* Effect.tryPromise({
        try: () =>
          select({
            message: "Select a file",
            options,
            maxItems: 5,
          }),
        catch: () => new ArgsError({ message: "No file selected" }),
      });
      if (isCancel(selectedPath)) {
        return yield* Effect.dieMessage("No file selected");
      }
      return yield* chooseFile(selectedPath);
    }

    const extension = path.extname(filepath);
    if (extension !== ".md") {
      return yield* Effect.dieMessage("File must have a .md extension");
    }

    return filepath;
  });

const program = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;

  const argFilePath = Option.fromNullable(process.argv[2]);
  const filePath = yield* Option.match(argFilePath, {
    onNone: () => chooseFile(path.join(process.cwd(), "outputs")),
    onSome: (filePath) => chooseFile(filePath),
  });

  const contents = yield* fileSystem.readFile(filePath);

  yield* makeAppleNoteFromMarkdown(new TextDecoder().decode(contents));
});

BunRuntime.runMain(program.pipe(Effect.provide(BunFileSystem.layer)));
