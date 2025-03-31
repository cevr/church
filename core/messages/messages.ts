import * as fs from "fs";
import * as path from "path";
import { Data, Effect } from "effect";
import { generateObject, generateText } from "ai";

import { isCancel, text } from "@clack/prompts";
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
import { log } from "~/lib/log";
import { Model } from "../model";
import { msToMinutes, spin } from "../lib";

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

export const makeMessage = (topic: string, points?: string[]) =>
  Effect.gen(function* () {
    const model = yield* Model;
    const response = yield* spin(
      "Generating message outline",
      Effect.tryPromise({
        try: () =>
          generateObject({
            model,
            schema: z.object({
              filename: z
                .string()
                .describe("The filename of the message. no extension."),
              message: z
                .string()
                .describe(
                  "The message to be written to the file. Markdown format, no code blocks, no ```markdown``` tags. Only the content, nothing else."
                ),
            }),
            messages: [
              {
                role: "system",
                content: systemMessagePrompt,
              },
              {
                role: "user",
                content: userMessagePrompt(topic, points),
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
    return { filename, message };
  });

const program = Effect.gen(function* (_) {
  const startTime = Date.now();

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

  const { filename, message } = yield* makeMessage(topic);

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
