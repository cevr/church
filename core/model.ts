import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenAI } from '@ai-sdk/openai';
import {
  wrapLanguageModel,
  type LanguageModelV1,
  type LanguageModelV1Middleware,
} from 'ai';
import { Effect, Match, Option, Schema } from 'effect';

import { matchEnum, select } from './lib';
import { ParseService } from './parse';

export enum Provider {
  Gemini = 'gemini',
  OpenAI = 'openai',
  Anthropic = 'anthropic',
}

const jsonFixingMiddleware: LanguageModelV1Middleware = {
  async wrapGenerate(options) {
    const result = await options.doGenerate();
    if (result.text) {
      // right now we see that the text is not valid json, so we need to fix it
      // here's an example of what we see 'ny\n```json...```\n\n'
      // we need to remove the ```json and ``` tags and the newlines and the random 'ny'
      let text = result.text;
      const nyStart = text.indexOf('ny');
      if (nyStart === 0) {
        text = text.slice(nyStart + 2);
        const jsonStart = text.indexOf('```json');
        const jsonEnd = text.lastIndexOf('```');
        if (jsonStart !== -1 && jsonEnd !== -1) {
          const json = text.slice(jsonStart + 7, jsonEnd);
          result.text = json;
        }
      }
    }
    return result;
  },
};
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
                high: wrapLanguageModel({
                  model: modelProvider('gemini-2.5-pro-preview-05-06'),
                  middleware: jsonFixingMiddleware,
                }),
                low: wrapLanguageModel({
                  model: modelProvider('gemini-2.0-flash-exp'),
                  middleware: jsonFixingMiddleware,
                }),
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

    const models = Option.reduceCompact(
      [google, openai, anthropic],
      [] as {
        models: { high: LanguageModelV1; low: LanguageModelV1 };
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
              Match.exhaustive,
            ),
          })),
        ),
      onSome: Effect.succeed,
    });
  }),
}) {}
