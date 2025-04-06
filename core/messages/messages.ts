import * as path from "path";
import { Data, Effect, Match, Option } from "effect";
import { generateObject, generateText } from "ai";

import { confirm, isCancel, select, text } from "@clack/prompts";
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
import { Parse } from "../parse";
import { FileSystem } from "@effect/platform";

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

class ActionError extends Data.TaggedError("ActionError")<{
  cause: unknown;
}> {}

enum Actions {
  Generate = "generate",
  Revise = "revise",
}

class ActionService extends Effect.Service<ActionService>()("Action", {
  effect: Effect.gen(function* () {
    const parse = yield* Parse;
    let action = yield* parse.command(Actions);

    return {
      action: yield* Option.match(action, {
        onSome: (a) => Effect.succeed(a),
        onNone: () =>
          Effect.gen(function* () {
            const selected = yield* Effect.tryPromise({
              try: () =>
                select({
                  message: "What would you like to do?",
                  options: [
                    { label: "Generate", value: Actions.Generate },
                    { label: "Revise", value: Actions.Revise },
                  ],
                }),
              catch: () => new ActionError({ cause: "No action selected" }),
            });

            if (isCancel(selected)) {
              return yield* Effect.dieMessage("Operation cancelled.");
            }

            return selected;
          }),
      }),
    };
  }),
}) {}

export const generate = (topic: string, points?: string[]) =>
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

    const revisedMessage = yield* revise(message);

    return {
      filename,
      message: Option.match(revisedMessage, {
        onSome: (i) => i,
        onNone: () => message,
      }),
    };
  });

const revise = (message: string) =>
  Effect.gen(function* () {
    const model = yield* Model;

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

    const userRevisionsRequested = yield* Effect.tryPromise({
      try: () =>
        confirm({
          message: "Would you like to make any revisions to the message?",
        }).then((r) => (isCancel(r) ? false : r)),
      catch: (cause: unknown) =>
        new PromptError({
          cause,
        }),
    });

    if (!needsRevision && !userRevisionsRequested) {
      return Option.none<string>();
    }

    const userRevisions = yield* Effect.tryPromise({
      try: () =>
        text({
          message: "Enter the revisions you would like to make to the message.",
        }).then((r) => (isCancel(r) ? [] : [r])),
      catch: (cause: unknown) =>
        new PromptError({
          cause,
        }),
    });

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
                content: userRevisePrompt(message, [
                  ...reviewResponse.object.revisions,
                  ...userRevisions,
                ]),
              },
            ],
          }),
        catch: (cause: unknown) =>
          new ReviseError({
            cause,
          }),
      })
    );

    return Option.some(revisedMessage.text);
  });

const generateMessage = Effect.gen(function* (_) {
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

  const { filename, message } = yield* generate(topic);

  const messagesDir = path.join(process.cwd(), "outputs", "messages");
  const filePath = path.join(messagesDir, `${filename}.md`);

  const fs = yield* FileSystem.FileSystem;

  yield* spin(
    "Ensuring messages directory exists",
    fs.makeDirectory(messagesDir)
  );

  yield* spin(
    "Writing message to file",
    fs.writeFile(filePath, new TextEncoder().encode(message))
  );

  yield* spin("Adding message to notes", makeAppleNoteFromMarkdown(message));

  const totalTime = msToMinutes(Date.now() - startTime);
  yield* log.success(
    `Message generated successfully! (Total time: ${totalTime})`
  );
});

const reviseMessage = Effect.gen(function* (_) {
  const fs = yield* FileSystem.FileSystem;
  const startTime = Date.now();

  const messagesDir = path.join(process.cwd(), "outputs", "messages");
  const files = yield* fs.readDirectory(messagesDir);

  const filePaths = files.map((file) => path.join(messagesDir, file));

  const filePath = yield* Effect.tryPromise({
    try: () =>
      select({
        message: "Which message would you like to revise?",
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
    yield* Effect.dieMessage("Operation cancelled.");
    return;
  }

  const message = yield* fs.readFile(filePath);

  const revisedMessage = yield* revise(new TextDecoder().decode(message));

  if (Option.isNone(revisedMessage)) {
    yield* log.error("No message to revise.");
    return;
  }

  yield* fs.writeFile(filePath, new TextEncoder().encode(revisedMessage.value));
});

const program = Effect.gen(function* () {
  const { action } = yield* ActionService;

  return yield* Match.value(action).pipe(
    Match.when(Actions.Generate, () => generateMessage),
    Match.when(Actions.Revise, () => reviseMessage),
    Match.exhaustive
  );
});

export const main = program.pipe(Effect.provide(ActionService.Default));
