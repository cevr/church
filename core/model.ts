import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createGroq } from '@ai-sdk/groq';
import { createOpenAI } from '@ai-sdk/openai';
import { Options, ValidationError } from '@effect/cli';
import { type LanguageModel } from 'ai';
import { Context, Effect, Match, Option, Schema } from 'effect';

import { matchEnum, select } from './lib';

export enum Provider {
  Gemini = 'gemini',
  OpenAI = 'openai',
  Anthropic = 'anthropic',
  Kimi = 'kimi',
}

const extractModel = Effect.fn('extractModel')(function* (
  modelOption: Option.Option<string>,
) {
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
              high: modelProvider('gemini-2.5-pro'),
              low: modelProvider('gemini-2.0-flash-exp'),
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
          return {
            models: {
              high: createOpenAI({ apiKey: openaiKey })('gpt-5'),
              low: createOpenAI({ apiKey: openaiKey })('gpt-5-nano'),
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
          return {
            models: {
              high: createAnthropic({ apiKey: anthropicKey })(
                'claude-4-sonnet-20250514',
              ),
              low: createAnthropic({ apiKey: anthropicKey })(
                'claude-3-5-haiku-20241022',
              ),
            },
            provider: Provider.Anthropic,
          };
        }),
      ),
    ),
  );
  const kimi = yield* Schema.Config('GROQ_API_KEY', Schema.NonEmptyString).pipe(
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
      select(
        'Select a model',
        models.map((model) => ({
          value: model.models,
          label: Match.value(model.provider).pipe(
            Match.when(Provider.Gemini, () => 'Gemini'),
            Match.when(Provider.OpenAI, () => 'OpenAI'),
            Match.when(Provider.Anthropic, () => 'Anthropic'),
            Match.when(Provider.Kimi, () => 'Kimi'),
            Match.exhaustive,
          ),
        })),
      ),
    onSome: Effect.succeed,
  });
});

export const model = Options.text('model').pipe(
  Options.withAlias('m'),
  Options.optional,
  Options.mapEffect((x) =>
    extractModel(x).pipe(
      Effect.mapError((e) =>
        ValidationError.invalidArgument({
          _tag: 'Empty',
        }),
      ),
    ),
  ),
);
export class Model extends Context.Tag('Model')<
  Model,
  Effect.Effect.Success<ReturnType<typeof extractModel>>
>() {}
