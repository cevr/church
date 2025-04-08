import { Effect, Option, Ref, Schema } from "effect";
import { matchSorter } from "match-sorter";
import { select } from "./lib";

export class ParseService extends Effect.Service<ParseService>()(
  "ParseService",
  {
    effect: Effect.gen(function* () {
      const levelRef = yield* Ref.make(0);
      const parseFlag = (flags: string[]) => {
        const args = process.argv.slice(2);
        for (const flag of flags) {
          const argEqualsIndex = args.findIndex((arg) =>
            arg.toLowerCase().includes(`-${flag.toLowerCase()}=`)
          );

          if (argEqualsIndex !== -1) {
            const arg = args[argEqualsIndex]?.split("=")[1];

            return Option.fromNullable(arg);
          }

          const argIndex = args.findIndex((arg) =>
            arg.toLowerCase().includes(`-${flag.toLowerCase()}`)
          );
          if (argIndex !== -1) {
            const arg = args[argIndex + 1];
            return Option.fromNullable(arg);
          }
        }

        return Option.none<string>();
      };

      const command = Effect.fn("ParseService.command")(function* <
        T extends Record<string, string | number>
      >(
        enumToParse: T,
        onNone: {
          message: string;
          labels: Record<T[keyof T], string>;
        }
      ) {
        const level = yield* levelRef.get;
        const args = process.argv
          .slice(2 + level)
          .reduce((acc, arg, i, arr) => {
            const lastArg = arr[i - 1];
            if (
              arg.includes("-") ||
              // if the last arg is a flag and doesn't have an =, then don't include this arg
              // since it means this arg is the value of the flag
              // if it has the equals, then it already has a value
              (lastArg?.includes("-") && !lastArg.includes("="))
            ) {
              return acc;
            }
            return [...acc, arg];
          }, [] as string[]);
        yield* levelRef.modify((l) => [l + 1, l + 1]);

        const arg = Option.fromNullable(args[0]);

        const schema = Schema.Enums(enumToParse);

        const option = yield* arg.pipe(
          Option.flatMap((c) => {
            const entries = Object.entries(enumToParse).map(([k, v]) => ({
              value: v as T[keyof T],
              labels: [
                enumToParse[k as keyof T],
                enumToParse[v as keyof T],
                onNone.labels[v as T[keyof T]],
              ],
            }));
            const matched = matchSorter(entries, c, {
              keys: ["labels"],
            })[0]?.value;
            return Option.fromNullable(matched);
          }),
          Effect.flatMap(Schema.decodeUnknown(schema)),
          Effect.option
        );

        return yield* Option.match(option, {
          onSome: (c) => Effect.succeed(c),
          onNone: () =>
            select(
              `${onNone.message}${Option.match(arg, {
                onSome: (c) => ` (initial: ${c})`,
                onNone: () => "",
              })}`,
              Object.values(enumToParse).map((value) => ({
                value: value as T[keyof T],
                label: onNone.labels[value as T[keyof T]],
              }))
            ),
        });
      });

      const flagSchema = <R, E>(flags: string[], schema: Schema.Schema<R, E>) =>
        parseFlag(flags).pipe(
          Option.flatMap(Schema.decodeUnknownOption(schema))
        );

      return {
        command,
        flag: parseFlag,
        flagSchema,
      };
    }),
  }
) {}
