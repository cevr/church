import { generateText } from 'ai';
import { Data, Effect, Option, Schedule } from 'effect';

import { Model } from '~/core/model';

import { doneChime } from './done-chime';
import { spin } from './general';
import { revise } from './revise';

class GenerateResponseError extends Data.TaggedError('GenerateResponseError')<{
  cause: unknown;
}> {}

class GenerateFilenameError extends Data.TaggedError('GenerateFilenameError')<{
  cause: unknown;
}> {}

export const generate = Effect.fn('generate')(function* (
  systemPrompt: string,
  prompt: string,
  options?: { skipRevisions?: boolean },
) {
  const models = yield* Model;

  const response = yield* spin(
    'Generating...',
    Effect.tryPromise({
      try: () =>
        generateText({
          model: models.high,
          messages: [
            {
              role: 'system',
              content: systemPrompt,
            },
            {
              role: 'user',
              content: prompt,
            },
          ],
        }),
      catch: (cause: unknown) =>
        new GenerateResponseError({
          cause,
        }),
    }).pipe(
      Effect.retry({
        times: 3,
        schedule: Schedule.spaced(500),
      }),
    ),
  );

  const message = response.text;

  yield* Effect.log(`response: \n\n ${message}`);

  const filename = yield* Effect.tryPromise({
    try: () =>
      generateText({
        model: models.low,
        messages: [
          {
            role: 'system',
            content:
              'Generate a filename for the following SDA bible study message. Kebab case. No extension. IMPORTANT: Only the filename, no other text. eg: christ-in-me-the-hope-of-glory',
          },
          { role: 'user', content: message },
        ],
      }),
    catch: (cause: unknown) =>
      new GenerateFilenameError({
        cause,
      }),
  });

  yield* doneChime;

  if (options?.skipRevisions) {
    return {
      filename: filename.text,
      response: response.text,
    };
  }

  const revisedResponse = yield* revise({
    cycles: [
      {
        prompt: prompt,
        response: response.text,
      },
    ],
    systemPrompt: systemPrompt,
  });

  return {
    filename: filename.text,
    response: Option.getOrElse(revisedResponse, () => response.text),
  };
});
