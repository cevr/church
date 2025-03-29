import { Effect, Option } from "effect";

export const parseCommand = Effect.sync(() => {
  const args = process.argv.slice(2);
  const command = args[0];

  return Option.fromNullable(command);
});

export const parseFlag = (flag: string) =>
  Effect.sync(() => {
    const args = process.argv.slice(2);
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
  });
