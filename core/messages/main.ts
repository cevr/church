import * as fs from "fs";
import * as path from "path";
import { Data, Effect, Schema } from "effect";
import { NodeRuntime } from "@effect/platform-node";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { generateObject, generateText } from "ai";

import { isCancel, text, spinner, log as clackLog } from "@clack/prompts";
import { z } from "zod";
import dotenv from "dotenv";
import {
  systemMessagePrompt,
  userMessagePrompt,
  systemReviewPrompt,
  userReviewPrompt,
  userRevisePrompt,
} from "./prompts";
import { makeAppleNoteFromMarkdown } from "lib/markdown-to-notes";

dotenv.config();

class PromptError extends Data.TaggedError("PromptError")<{
  cause: unknown;
}> {}

class OutlineError extends Data.TaggedError("OutlineError")<{
  cause: unknown;
}> {}

class ReviewError extends Data.TaggedError("ReviewError")<{
  cause: unknown;
}> {}

class ReviseError extends Data.TaggedError("ReviseError")<{
  cause: unknown;
}> {}

class FilesystemError extends Data.TaggedError("FilesystemError")<{
  cause: unknown;
}> {}

const MessageSchema = z.object({
  filename: z.string().describe("The filename of the message. no extension."),
  message: z
    .string()
    .describe(
      "The message to be written to the file. Markdown format, no code blocks."
    ),
});

const msToMinutes = (ms: number) => {
  const minutes = Math.floor(ms / 60000);
  const seconds = Math.floor((ms % 60000) / 1000);
  return `${minutes}m:${seconds.toString().padStart(2, "0")}s`;
};

class Model extends Effect.Service<Model>()("Model", {
  effect: Effect.gen(function* (_) {
    const key = yield* Schema.Config("GEMINI_API_KEY", Schema.NonEmptyString);
    const model = createGoogleGenerativeAI({
      apiKey: key,
    })("gemini-2.5-pro-exp-03-25");

    return model;
  }),
}) {}

const spin = <V, E, R>(message: string, job: Effect.Effect<V, E, R>) =>
  Effect.gen(function* () {
    const start = Date.now();
    const s = yield* Effect.sync(() => spinner());
    yield* Effect.sync(() => s.start(message + "..."));
    const result = yield* job;
    yield* Effect.sync(() =>
      s.stop(`${message} done! (${msToMinutes(Date.now() - start)})`)
    );
    return result;
  });

const log = {
  info: (message: string) => Effect.sync(() => clackLog.info(message)),
  error: (message: string) => Effect.sync(() => clackLog.error(message)),
  success: (message: string) => Effect.sync(() => clackLog.success(message)),
  warn: (message: string) => Effect.sync(() => clackLog.warn(message)),
};

const program = Effect.gen(function* (_) {
  const startTime = Date.now();
  const model = yield* Model;

  const topic = yield* Effect.tryPromise({
    try: () =>
      text({
        message: "What would you like the message to be about?",
        placeholder: "e.g., The Power of Prayer",
      }),
    catch: (cause: unknown) =>
      new PromptError({
        cause,
      }),
  });

  if (isCancel(topic)) {
    yield* Effect.dieMessage("Operation cancelled.");
    return;
  }

  const response = yield* spin(
    "Generating message outline",
    Effect.tryPromise({
      try: () =>
        generateObject({
          model,
          schema: MessageSchema,
          messages: [
            {
              role: "system",
              content: systemMessagePrompt,
            },
            {
              role: "user",
              content: userMessagePrompt(topic),
            },
          ],
        }),
      catch: (cause: unknown) =>
        new OutlineError({
          cause,
        }),
    })
  );

  let { filename, message } = response.object;

  const reviewResponse = yield* spin(
    "Reviewing message",
    Effect.tryPromise({
      try: () =>
        generateObject({
          model,
          schema: z.object({
            needsRevision: z
              .boolean()
              .describe("Whether the message needs revision"),
            revisions: z
              .array(z.string())
              .describe("The specific criteria that need revision"),
          }),
          messages: [
            {
              role: "system",
              content: systemReviewPrompt,
            },
            {
              role: "user",
              content: userReviewPrompt(message),
            },
          ],
        }),
      catch: (cause: unknown) =>
        new ReviewError({
          cause,
        }),
    })
  );

  const needsRevision = reviewResponse.object.needsRevision;

  yield* log.info(`needsRevision: ${needsRevision}`);

  if (needsRevision) {
    const revisedMessage = yield* spin(
      "Revising message",
      Effect.tryPromise({
        try: () =>
          generateText({
            model,
            messages: [
              {
                role: "system",
                content: systemReviewPrompt,
              },
              {
                role: "user",
                content: userRevisePrompt(
                  message,
                  reviewResponse.object.revisions
                ),
              },
            ],
          }),
        catch: (cause: unknown) =>
          new ReviseError({
            cause,
          }),
      })
    );

    message = revisedMessage.text;
  }

  const messagesDir = path.join(process.cwd(), "outputs", "messages");
  const filePath = path.join(messagesDir, `${filename}.md`);

  yield* spin(
    "Ensuring messages directory exists",
    Effect.try({
      try: () => fs.mkdirSync(messagesDir, { recursive: true }),
      catch: (cause: unknown) =>
        new FilesystemError({
          cause,
        }),
    })
  );

  yield* spin(
    "Writing message to file",
    Effect.try({
      try: () => fs.writeFileSync(filePath, message),
      catch: (cause: unknown) =>
        new FilesystemError({
          cause,
        }),
    })
  );

  yield* spin("Adding message to notes", makeAppleNoteFromMarkdown(message));

  const totalTime = msToMinutes(Date.now() - startTime);
  yield* log.success(
    `Message generated successfully! (Total time: ${totalTime})`
  );
});

export const main = program.pipe(Effect.provide(Model.Default));
