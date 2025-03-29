import { matchSorter } from "match-sorter";
import { main as messagesMain } from "./messages/main";
import { parseCommand } from "./parse";
import { main as sabbathSchoolMain } from "./sabbath-school/main";
import { Effect, Match, Option, Schema } from "effect";
import { isCancel, select } from "@clack/prompts";
import { NodeRuntime } from "@effect/platform-node";

enum Command {
  Messages = "messages",
  SabbathSchool = "sabbath-school",
}

class CommandService extends Effect.Service<CommandService>()("Command", {
  effect: Effect.gen(function* () {
    let command = yield* parseCommand.pipe(
      Effect.map((o) =>
        o.pipe(
          Option.flatMap((c) =>
            Option.fromNullable(
              matchSorter([Command.Messages, Command.SabbathSchool], c)
            )
          ),
          Option.map((c) => Schema.decodeUnknown(Schema.Enums(Command))(c))
        )
      )
    );

    return {
      command: yield* Option.match(command, {
        onSome: (c) => c,
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
}) {}

const main = Effect.gen(function* () {
  const command = yield* CommandService;

  return yield* Match.value(command.command).pipe(
    Match.when(Command.Messages, () => messagesMain),
    Match.when(Command.SabbathSchool, () => sabbathSchoolMain),
    Match.exhaustive
  );
}).pipe(Effect.provide(CommandService.Default));

NodeRuntime.runMain(main);
