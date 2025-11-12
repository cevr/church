import { confirm, text } from '@effect/cli/Prompt';
import { generateText } from 'ai';
import { Array, Data, Effect, Option } from 'effect';
import type { NonEmptyArray } from 'effect/Array';

import { Model } from '~/core/model';

import { doneChime } from './done-chime';
import { spin } from './general';

class ReviewError extends Data.TaggedError('ReviewError')<{
  cause: unknown;
}> {}

interface ReviserContext {
  systemPrompt: string;
  cycles: NonEmptyArray<{ prompt: string; response: string }>;
}

export const revise = Effect.fn('revise')(function* ({
  cycles,
  systemPrompt,
}: ReviserContext) {
  const models = yield* Model;
  let revisions = [...cycles];

  while (true) {
    let shouldRevise = yield* confirm({
      message: 'Revise?',
      initial: false,
    });

    if (!shouldRevise) {
      if (revisions.length === 1) {
        return Option.none<string>();
      }
      return Array.last(revisions).pipe(Option.map((i) => i.response));
    }

    const userRevision = yield* text({
      message: 'What are the revisions to be made?',
    });

    const reviseResponse = yield* spin(
      'Revising text',
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
                content: userRevisePrompt(revisions, userRevision),
              },
            ],
          }),
        catch: (cause: unknown) =>
          new ReviewError({
            cause,
          }),
      }),
    );

    yield* doneChime;

    yield* Effect.log(`reviseResponse: ${reviseResponse.text}`);
    revisions.push({
      prompt: userRevision,
      response: reviseResponse.text,
    });
  }
});

export const userRevisePrompt = (
  cycles: {
    prompt: string;
    response: string;
  }[],
  revision: string,
) => `
Please revise the following text to be inline with the criteria below.
- IMPORTANT: Only return the revised text, nothing else.

<revision-cycles>
  ${cycles
    .map(
      (cycle) => `
    <cycle>
      <prompt>${cycle.prompt}</prompt>
      <response>${cycle.response}</response>
    </cycle>
  `,
    )
    .join('\n')}
</revision-cycles>

<revision>
  ${revision}
</revision>
`;
