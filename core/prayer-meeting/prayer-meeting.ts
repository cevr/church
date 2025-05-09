import * as path from 'path';

import { isCancel, select } from '@clack/prompts';
import { FileSystem, HttpClient } from '@effect/platform';
import { BunFileSystem } from '@effect/platform-bun';
import { NodeHttpClient } from '@effect/platform-node';
import { generateText } from 'ai';
import { eachDayOfInterval, endOfWeek, format, startOfWeek } from 'date-fns';
import dotenv from 'dotenv';
import {
  Array,
  Chunk,
  Data,
  Effect,
  Match,
  Option,
  Schedule,
  Schema,
} from 'effect';

import { log } from '~/lib/log';

import { msToMinutes, spin } from '../lib';
import { ModelService } from '../model';
import { ParseService } from '../parse';

dotenv.config();

const EGW_API_BASE_URL = 'https://a.egwwritings.org';

// --- API Schemas ---
const BookSchema = Schema.Struct({
  book_id: Schema.Number,
  book_code: Schema.String,
  title: Schema.String,
});
type Book = typeof BookSchema.Type;

const BooksResponseSchema = Schema.Struct({
  items: Schema.Array(BookSchema),
});
// --- End API Schemas ---

class HttpClientError extends Schema.TaggedError<HttpClientError>(
  'HttpClientError',
)('HttpClientError', {
  status: Schema.Number,
  url: Schema.String,
  cause: Schema.optional(Schema.Unknown),
}) {
  static is = Schema.is(this);
}

// --- Utility Functions ---
const makeRequest = Effect.fn('makeRequest')(function* <A, E, R>(
  url: string,
  responseSchema: Schema.Schema<A, E, R>,
) {
  const response = yield* HttpClient.get(url).pipe(
    Effect.flatMap((response) => {
      if (response.status !== 200) {
        return Effect.fail(
          new HttpClientError({
            status: response.status,
            url,
          }),
        );
      }

      return Effect.succeed(response);
    }),
    Effect.retry({
      while: HttpClientError.is,
      schedule: Schedule.intersect(
        Schedule.recurs(3),
        Schedule.exponential(500),
      ),
    }),
    Effect.flatMap((response) => response.json),
  );

  return yield* Schema.decodeUnknown(responseSchema)(response);
});

// --- End Utility Functions ---

class PromptError extends Data.TaggedError('PromptError')<{
  cause: unknown;
}> {}

class StudyGenerationError extends Data.TaggedError('StudyGenerationError')<{
  cause: unknown;
}> {}

class ApiError extends Data.TaggedError('ApiError')<{
  cause?: unknown;
  message: string;
}> {}

class FilenameError extends Data.TaggedError('FilenameError')<{
  cause: unknown;
}> {}

enum Actions {
  Generate = 'generate',
}

class ActionService extends Effect.Service<ActionService>()('Action', {
  effect: Effect.gen(function* () {
    const parse = yield* ParseService;
    let action = yield* parse.command(Actions, {
      message: 'What would you like to do?',
      labels: {
        [Actions.Generate]: 'Generate Prayer Meeting Study',
      },
    });

    return {
      action,
    };
  }),
}) {}

// Fetches the list of available devotionals from the API
const fetchDevotionalList = Effect.fn('fetchDevotionalList')(function* () {
  const url = `${EGW_API_BASE_URL}/content/books?type=devotional&lang=en`;
  yield* log.info(`Fetching devotional list from: ${url}`);
  const response = yield* makeRequest(url, BooksResponseSchema);
  // Use Array.map and provide explicit type for book
  const devotionals = Array.map(response.items, (book) => ({
    value: book.book_id.toString(),
    label: book.title,
  }));

  if (Array.isEmptyArray(devotionals)) {
    return yield* Effect.fail(
      new ApiError({ message: 'No devotionals found via API.' }),
    );
  }

  return devotionals;
});

const getDevotionalContent = Effect.fn('getDevotionalContent')(function* (
  bookId: string,
  week: string,
) {
  const url = `${EGW_API_BASE_URL}/content/books/${bookId}/devotionals?lang=en&week=${week}`;
  yield* log.info(`Fetching devotional content from: ${url}`);
  const response = yield* makeRequest(url, BooksResponseSchema);
  return response.items;
});

export const generateStudy = Effect.fn('generateStudy')(function* (
  content: string[],
) {
  const models = yield* ModelService;
  const fs = yield* FileSystem.FileSystem;

  const systemMessagePrompt = yield* fs
    .readFile(
      path.join(
        process.cwd(),
        'core',
        'prayer-meeting',
        'prompts',
        'generate.md',
      ),
    )
    .pipe(Effect.map((i) => new TextDecoder().decode(i)));

  const response = yield* spin(
    'Generating prayer meeting study outline',
    Effect.tryPromise({
      try: () =>
        generateText({
          model: models.high,
          messages: [
            {
              role: 'system',
              content: systemMessagePrompt,
            },
            {
              role: 'user',
              content: `Generate a cohesive prayer meeting study outline based on the following EGW devotional content. Synthesize the key themes and points. Include discussion questions, relevant scripture references, and focus on practical application.
Devotional Content:
${content.join('\n --- \n')}`,
            },
          ],
        }),
      catch: (cause: unknown) =>
        new StudyGenerationError({
          cause,
        }),
    }).pipe(
      Effect.retry({
        times: 3,
        schedule: Schedule.spaced(500),
      }),
    ),
  );

  const studyContent = response.text;

  return studyContent;
});

const generatePrayerMeeting = Effect.gen(function* (_) {
  const startTime = Date.now();
  const fs = yield* FileSystem.FileSystem; // Get FileSystem service

  // Fetch the list of devotionals from the API
  const availableDevotionals = yield* spin(
    'Fetching available devotionals...',
    fetchDevotionalList(),
  );

  const selectedDevotionalValue = yield* Effect.tryPromise({
    try: () =>
      select({
        message: 'Select the EGW devotional for the study:',
        options: availableDevotionals,
        maxItems: 10,
      }),
    catch: (cause: unknown) =>
      new PromptError({
        cause,
      }),
  });

  if (isCancel(selectedDevotionalValue)) {
    yield* Effect.dieMessage('Operation cancelled.');
    return;
  }

  // Find the selected devotional object from the fetched list
  const selectedDevotional = availableDevotionals.find(
    (d: { value: string; label: string }) =>
      d.value === selectedDevotionalValue,
  );

  if (!selectedDevotional) {
    yield* Effect.dieMessage('Invalid devotional selected.');
    return;
  }

  const devotionalName = selectedDevotional.label;
  const devotionalBookIdStr = selectedDevotionalValue;

  // --- Current Week Logic ---
  const now = new Date();
  const weekStart = startOfWeek(now, { weekStartsOn: 0 });
  const weekEnd = endOfWeek(now, { weekStartsOn: 0 });
  const daysInWeek = eachDayOfInterval({ start: weekStart, end: weekEnd });
  const dailyTopics = daysInWeek.map((day) => format(day, 'MMMM d')); // Dates as "Month Day"
  const weekStartDateString = format(weekStart, 'yyyy-MM-dd');
  // --- End Current Week Logic ---

  yield* log.info(
    `Generating study for: ${devotionalName} (ID: ${devotionalBookIdStr})`,
  );
  yield* log.info(`Current week dates: ${dailyTopics.join(', ')}`);

  // Fetch the devotional content for the week (using placeholder)
  const devotionalContent = yield* spin(
    'Fetching devotional content (simulated)',
    getDevotionalContent(devotionalName), // Pass name and topics
  );

  // Generate the study using the fetched content
  const studyContent = yield* generateStudy(devotionalContent);

  const prayerMeetingsDir = path.join(
    process.cwd(),
    'outputs',
    'prayer-meetings',
  );
  const devotionalDate = format(weekStart, 'yyyy');
  const devotionalWeek = format(weekStart, 'w');
  // file name will be YYYY-W${week}-devotional-name.md
  const fileName = `${devotionalDate}-W${devotionalWeek}-${devotionalName}.md`;
  const filePath = path.join(prayerMeetingsDir, fileName);

  // Ensure directory exists before writing
  yield* spin(
    'Ensuring prayer meetings directory exists',
    fs
      .makeDirectory(prayerMeetingsDir, { recursive: true })
      .pipe(Effect.ignore), // Added recursive flag
  );

  yield* spin(
    'Writing study to file: ' + fileName,
    fs.writeFileString(filePath, studyContent), // Use writeFileString for simplicity
  );

  const totalTime = msToMinutes(Date.now() - startTime);
  yield* log.success(
    `Prayer meeting study generated successfully! (Total time: ${totalTime})`,
  );
});

const program = Effect.gen(function* () {
  const { action } = yield* ActionService;

  return yield* Match.value(action).pipe(
    Match.when(Actions.Generate, () => generatePrayerMeeting),
    Match.exhaustive,
  );
});

// Provide necessary layers (FileSystem is needed now)
export const main = program.pipe(
  Effect.provide(ActionService.Default),
  Effect.provide(BunFileSystem.layer),
  Effect.provide(NodeHttpClient.layer),
);
