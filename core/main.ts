import { Effect, Layer, Match, Option } from "effect";
import { isCancel, select } from "@clack/prompts";

import { ParseService } from "./parse";
import { main as messagesMain } from "./messages/messages";
import { main as sabbathSchoolMain } from "./sabbath-school/sabbath-school";
import { main as eldersDigestMain } from "./elders-digest/elders-digest";
import { ModelService } from "./model";
import { BunFileSystem, BunRuntime } from "@effect/platform-bun";

enum Command {
  Messages = "messages",
  SabbathSchool = "sabbath-school",
  EldersDigest = "elders-digest",
}

class CommandService extends Effect.Service<CommandService>()("Command", {
  effect: Effect.gen(function* () {
    const parse = yield* ParseService;
    let command = yield* parse.command(Command, {
      message: "Select a command",
      labels: {
        [Command.Messages]: "Messages",
        [Command.SabbathSchool]: "Sabbath School",
        [Command.EldersDigest]: "Elders Digest",
      },
    });
    return {
      command,
    };
  }),
}) {}

const main = Effect.gen(function* () {
  const { command } = yield* CommandService;

  return yield* Match.value(command).pipe(
    Match.when(Command.Messages, () => messagesMain),
    Match.when(Command.SabbathSchool, () => sabbathSchoolMain),
    Match.when(Command.EldersDigest, () => eldersDigestMain),
    Match.exhaustive
  );
}).pipe(
  Effect.provide(CommandService.Default),
  Effect.provide(
    Layer.provideMerge(ModelService.Default, ParseService.Default)
  ),
  Effect.provide(BunFileSystem.layer)
);

BunRuntime.runMain(main);
