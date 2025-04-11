import path from 'path';

import { isCancel, text } from '@clack/prompts';
import { FileSystem } from '@effect/platform';
import { generateObject } from 'ai';
import { Array, Data, Effect, Option, Schema, Stream } from 'effect';
import { z } from 'zod';

import { spin } from '../lib';
import { generate } from '../messages/messages';
import { ModelService } from '../model';
import { eldersDigestSystemPrompt } from './prompts';

//cdn.ministerialassociation.org/cdn/eldersdigest.org/issues/ED%20Q1%201994.pdf
const getEldersDigestPdfUrl = (year: number, quarter: number) =>
  `https://cdn.ministerialassociation.org/cdn/eldersdigest.org/issues/ED%20Q${quarter}%20${year}.pdf`;

class SermonFetchError extends Data.TaggedError('SermonFetchError')<{
  url: string;
  cause: unknown;
}> {}

const downloadPdf = Effect.fn('downloadPdf')(function* (url: string) {
  return yield* Effect.tryPromise({
    try: () =>
      fetch(url).then((r) => {
        if (!r.ok) {
          throw new Error(`Failed to fetch ${url}`);
        }
        return r.arrayBuffer();
      }),
    catch: (cause) => new SermonFetchError({ url, cause }),
  }).pipe(
    Effect.tap((pdf) => Effect.log(`Downloaded ${pdf.byteLength} bytes`)),
    Effect.option,
  );
});

class SermonExtractionError extends Data.TaggedError('SermonExtractionError')<{
  cause: unknown;
}> {}

const getExtractedContent = Effect.fn('getExtractedContent')(function* (
  pdf: ArrayBuffer,
) {
  const model = yield* ModelService;
  const response = yield* spin(
    'Extracting content...',
    Effect.tryPromise({
      try: () =>
        generateObject({
          model,
          schema: z.array(
            z.object({
              title: z
                .string()
                .describe(
                  'The title of the sermon relevant to the extracted content  ',
                ),
              content: z
                .array(z.string())
                .describe('The extracted truth/themes/kernels from the sermon'),
            }),
          ),
          messages: [
            {
              role: 'system',
              content: eldersDigestSystemPrompt,
            },
            {
              role: 'user',
              content: [
                {
                  type: 'file',
                  data: pdf,
                  mimeType: 'application/pdf',
                },
              ],
            },
          ],
        }),
      catch: (cause) => new SermonExtractionError({ cause }),
    }),
  );
  return response.object;
});

class ArgumentError extends Data.TaggedError('ArgumentError')<{
  cause: unknown;
}> {}

export const main = Effect.gen(function* () {
  const year = yield* Effect.tryPromise({
    try: () =>
      text({
        message: 'Enter the year',
        placeholder: new Date().getFullYear().toString(),
        validate: (value) => {
          if (isNaN(Number(value))) {
            return 'Invalid year';
          }
        },
      }),
    catch: (cause) => new ArgumentError({ cause }),
  }).pipe(
    Effect.map((x) => {
      if (isCancel(x)) {
        return Effect.dieMessage('Cancelled');
      }
      return x;
    }),
    Effect.map(Schema.decodeUnknownSync(Schema.NumberFromString)),
  );
  const years = Array.range(year, new Date().getFullYear());
  const quarters = Array.range(1, 4);

  const urls = years.flatMap((year) =>
    quarters.map((quarter) => getEldersDigestPdfUrl(year, quarter)),
  );

  const fs = yield* FileSystem.FileSystem;

  yield* fs.makeDirectory(
    path.join(process.cwd(), 'outputs', 'elders-digest'),
    {
      recursive: true,
    },
  );

  yield* Stream.fromIterable(urls).pipe(
    Stream.mapEffect(downloadPdf),
    Stream.filter(Option.isSome),
    Stream.map(Option.getOrThrow),
    Stream.mapEffect((pdf) =>
      Effect.gen(function* () {
        const contents = yield* getExtractedContent(pdf);
        yield* Effect.forEach(contents, (content) =>
          Effect.gen(function* () {
            const message = yield* generate(content.title, content.content);
            yield* spin(
              `Writing ${message.filename}`,
              fs.writeFile(
                path.join(
                  process.cwd(),
                  'outputs',
                  'elders-digest',
                  `${message.filename}.md`,
                ),
                new TextEncoder().encode(message.message),
              ),
            );
          }),
        );
      }),
    ),
    Stream.runDrain,
  );
});
