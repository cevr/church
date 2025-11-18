import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createGroq } from '@ai-sdk/groq';
import { createOpenAI } from '@ai-sdk/openai';
import { Options, ValidationError } from '@effect/cli';
import { select } from '@effect/cli/Prompt';
import { type LanguageModel } from 'ai';
import { Context, Effect, Match, Option, Schema } from 'effect';

import { matchEnum } from '../lib/general';

export enum Provider {
  Gemini = 'gemini',
  OpenAI = 'openai',
  Anthropic = 'anthropic',
  Kimi = 'kimi',
}

const extractModel = Effect.fn('extractModel')(
  function* (modelOption: Option.Option<string>) {
    const google = yield* Schema.Config(
      'GEMINI_API_KEY',
      Schema.NonEmptyString,
    ).pipe(
      Effect.option,
      Effect.map((googleKey) =>
        googleKey.pipe(
          Option.map((googleKey) => {
            const modelProvider = createGoogleGenerativeAI({
              apiKey: googleKey,
            });
            return {
              models: {
                high: modelProvider('gemini-3.0-pro'),
                low: modelProvider('gemini-2.5-flash-lite'),
              },
              provider: Provider.Gemini,
            };
          }),
        ),
      ),
    );
    const openai = yield* Schema.Config(
      'OPENAI_API_KEY',
      Schema.NonEmptyString,
    ).pipe(
      Effect.option,
      Effect.map((openaiKey) =>
        openaiKey.pipe(
          Option.map((openaiKey) => {
            const modelProvider = createOpenAI({ apiKey: openaiKey });
            return {
              models: {
                high: modelProvider('gpt-5.1'),
                low: modelProvider('gpt-5-nano'),
              },
              provider: Provider.OpenAI,
            };
          }),
        ),
      ),
    );
    const anthropic = yield* Schema.Config(
      'ANTHROPIC_API_KEY',
      Schema.NonEmptyString,
    ).pipe(
      Effect.option,
      Effect.map((anthropicKey) =>
        anthropicKey.pipe(
          Option.map((anthropicKey) => {
            const modelProvider = createAnthropic({ apiKey: anthropicKey });
            return {
              models: {
                high: modelProvider('claude-sonnet-4-5'),
                low: modelProvider('claude-haiku-4-5'),
              },
              provider: Provider.Anthropic,
            };
          }),
        ),
      ),
    );
    const kimi = yield* Schema.Config(
      'GROQ_API_KEY',
      Schema.NonEmptyString,
    ).pipe(
      Effect.option,
      Effect.map((groqKey) =>
        groqKey.pipe(
          Option.map((groqKey) => {
            const modelProvider = createGroq({ apiKey: groqKey });
            return {
              models: {
                high: modelProvider('moonshotai/kimi-k2-instruct'),
                low: modelProvider('moonshotai/kimi-k2-instruct'),
              },
              provider: Provider.Kimi,
            };
          }),
        ),
      ),
    );
    const models = Option.reduceCompact(
      [
        google,
        openai,
        anthropic,
        kimi as unknown as Option.Option<{
          models: { high: LanguageModel; low: LanguageModel };
          provider: Provider;
        }>,
      ],
      [] as {
        models: { high: LanguageModel; low: LanguageModel };
        provider: Provider;
      }[],
      (acc, model) => [...acc, model],
    );

    if (models.length === 0) {
      return yield* Effect.dieMessage('No model provider found');
    }

    const model = modelOption.pipe(
      Option.flatMap((model) => matchEnum(Provider, model)),
      Option.flatMap((model) =>
        Option.fromNullable(models.find((m) => m.provider === model)?.models),
      ),
    );

    return yield* Option.match(model, {
      onNone: () =>
        select({
          message: 'Select a model',
          choices: models.map((model) => ({
            value: model.models,
            title: Match.value(model.provider).pipe(
              Match.when(Provider.Gemini, () => 'Gemini'),
              Match.when(Provider.OpenAI, () => 'OpenAI'),
              Match.when(Provider.Anthropic, () => 'Anthropic'),
              Match.when(Provider.Kimi, () => 'Kimi'),
              Match.exhaustive,
            ),
          })),
        }),
      onSome: Effect.succeed,
    });
  },
  Effect.mapError(() =>
    ValidationError.invalidArgument({
      _tag: 'Empty',
    }),
  ),
);

export const model = Options.text('model').pipe(
  Options.withAlias('m'),
  Options.optional,
  Options.mapEffect(extractModel),
);
export class Model extends Context.Tag('Model')<
  Model,
  Effect.Effect.Success<ReturnType<typeof extractModel>>
>() {}
