import { Context, Effect, Layer, Option, Ref } from "effect";
import { log } from "~/lib/log";

const main = Effect.gen(function* () {
  const levelRef = yield* Ref.make(0);

  return {
    command: Effect.gen(function* () {
      const level = yield* levelRef.get;
      yield* log.info(`Level: ${level}`);
      const args = process.argv.slice(2 + level);
      yield* levelRef.modify((l) => [l + 1, l + 1]);

      return Option.fromNullable(args[0]);
    }),
    flag: (flag: string) =>
      Effect.gen(function* () {
        const level = yield* levelRef.get;
        const args = process.argv.slice(2 + level);

        const argEqualsIndex = args.findIndex((arg) => arg === `${flag}=`);

        if (argEqualsIndex !== -1) {
          const arg = args[argEqualsIndex + 1];
          if (arg) {
            return Option.fromNullable(arg);
          }
        }

        const argIndex = args.findIndex((arg) => arg === flag);
        if (argIndex !== -1) {
          const arg = args[argIndex + 1];
          return Option.fromNullable(arg);
        }

        return Option.none<string>();
      }),
  };
});
export class Parse extends Effect.Service<Parse>()("Parse", {
  effect: main,
}) {}
