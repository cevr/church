import { Effect, Option, Ref, Schema } from "effect";
import { matchSorter } from "match-sorter";

const main = Effect.gen(function* () {
  const levelRef = yield* Ref.make(0);
  const parseFlag = (flags: string[]) => {
    const args = process.argv.slice(2);
    for (const flag of flags) {
      const argEqualsIndex = args.findIndex((arg) =>
        arg.toLowerCase().startsWith(`--${flag.toLowerCase()}=`)
      );

      if (argEqualsIndex !== -1) {
        const arg = args[argEqualsIndex + 1];

        if (arg) {
          return Option.fromNullable(arg);
        }
      }

      const argIndex = args.findIndex((arg) =>
        arg.toLowerCase().startsWith(`--${flag.toLowerCase()}`)
      );
      if (argIndex !== -1) {
        const arg = args[argIndex + 1];
        return Option.fromNullable(arg);
      }
    }

    return Option.none<string>();
  };

  return {
    command: <T extends Record<string, string | number>>(e: T) =>
      Effect.gen(function* () {
        const level = yield* levelRef.get;
        const args = process.argv.slice(2 + level);
        yield* levelRef.modify((l) => [l + 1, l + 1]);

        return Option.fromNullable(args[0]).pipe(
          Option.flatMap((c) =>
            Option.fromNullable(matchSorter(Object.values(e), c)[0])
          ),
          Option.map((c) => Schema.decodeUnknownSync(Schema.Enums(e))(c))
        );
      }),
    flag: parseFlag,
    flagSchema: <A, E>(flags: string[], schema: Schema.Schema<A, E>) =>
      parseFlag(flags).pipe(Option.flatMap(Schema.decodeUnknownOption(schema))),
  };
});
export class Parse extends Effect.Service<Parse>()("Parse", {
  effect: main,
}) {}
