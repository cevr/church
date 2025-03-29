import { matchSorter } from "match-sorter";
import { main as messagesMain } from "./messages/messages";
import { Parse } from "./parse";
import { main as sabbathSchoolMain } from "./sabbath-school/sabbath-school";
import { Effect, Layer, Match, Option, Schema } from "effect";
import { isCancel, select } from "@clack/prompts";
import { NodeRuntime } from "@effect/platform-node";

enum Command {
  Messages = "messages",
  SabbathSchool = "sabbath-school",
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
    Match.exhaustive
  );
}).pipe(Effect.provide(Layer.merge(Parse.Default, CommandService.Default)));

NodeRuntime.runMain(main);
