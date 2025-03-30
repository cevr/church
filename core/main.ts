import { Effect, Layer, Match, Option } from "effect";
import { isCancel, select } from "@clack/prompts";
import { NodeFileSystem, NodeRuntime } from "@effect/platform-node";

import { Parse } from "./parse";
import { main as messagesMain } from "./messages/messages";
import { main as sabbathSchoolMain } from "./sabbath-school/sabbath-school";
import { main as eldersDigestMain } from "./elders-digest/elders-digest";
import { Model } from "./model";

enum Command {
  Messages = "messages",
  SabbathSchool = "sabbath-school",
  EldersDigest = "elders-digest",
}

class CommandService extends Effect.Service<CommandService>()("Command", {
  effect: Effect.gen(function* () {
    const parse = yield* Parse;
    let command = yield* parse.command(Command);

    return {
      command: yield* Option.match(command, {
        onSome: (c) => Effect.succeed(c),
        onNone: () =>
          Effect.gen(function* () {
            const command = yield* Effect.tryPromise(() =>
              select({
                message: "Select a command",
                options: [
                  { label: "Messages", value: Command.Messages },
                  { label: "Sabbath School", value: Command.SabbathSchool },
                  { label: "Elders Digest", value: Command.EldersDigest },
                ],
              })
            );

            if (isCancel(command)) {
              return yield* Effect.dieMessage("Cancelled");
            }

            return command;
          }),
      }),
    };
  }),
  dependencies: [Parse.Default],
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
  Effect.provide(Layer.merge(Parse.Default, CommandService.Default)),
  Effect.provide(NodeFileSystem.layer),
  Effect.provide(Model.Default)
);

NodeRuntime.runMain(main);
