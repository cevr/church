import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createGroq } from '@ai-sdk/groq';
import { createOpenAI } from '@ai-sdk/openai';
import { type LanguageModel } from 'ai';
import { Effect, Match, Option, Schema } from 'effect';

import { matchEnum, select } from './lib';
import { ParseService } from './parse';

export enum Provider {
  Gemini = 'gemini',
  OpenAI = 'openai',
  Anthropic = 'anthropic',
  Groq = 'groq',
}

export class ModelService extends Effect.Service<ModelService>()('Model', {
  effect: Effect.gen(function* (_) {
    const parse = yield* ParseService;
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
                high: createOpenAI({ apiKey: openaiKey })('gpt-4.1-2025-04-14'),
                low: createOpenAI({ apiKey: openaiKey })(
                  'gpt-4.1-mini-2025-04-14',
                ),
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
    const groq = yield* Schema.Config(
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
              provider: Provider.Groq,
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
        groq as unknown as Option.Option<{
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

    const model = parse.flag(['model', 'm']).pipe(
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
              Match.when(Provider.Groq, () => 'Groq'),
              Match.exhaustive,
            ),
          })),
        ),
      onSome: Effect.succeed,
    });
  }),
}) {}
