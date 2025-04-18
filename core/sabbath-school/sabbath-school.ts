import * as path from 'path';

import { isCancel, select } from '@clack/prompts';
import { FileSystem } from '@effect/platform';
import { generateObject, generateText } from 'ai';
import * as cheerio from 'cheerio';
import dotenv from 'dotenv';
import { Array, Data, Effect, Match, Option, Schema, Stream } from 'effect';
import { z } from 'zod';

import { ParseService } from '~/core/parse';

import { makeAppleNoteFromMarkdown } from '../../lib/markdown-to-notes';
import { msToMinutes } from '../lib';
import { ModelService } from '../model';
import {
  outlineSystemPrompt,
  outlineUserPrompt,
  reviewCheckSystemPrompt,
  reviewCheckUserPrompt,
  reviseSystemPrompt,
  reviseUserPrompt,
} from './prompts';

dotenv.config();

class OutlineError extends Data.TaggedError('OutlineError')<{
  context: SabbathSchoolContext;
  cause: unknown;
}> {}

class DownloadError extends Data.TaggedError('DownloadError')<{
  week: number;
  cause: unknown;
}> {}

class CheerioError extends Data.TaggedError('CheerioError')<{
  week: number;
  cause: unknown;
}> {}

class MissingPdfError extends Data.TaggedError('MissingPdfError')<{
  quarter: number;
}> {}

class ReviewError extends Data.TaggedError('ReviewError')<{
  context: SabbathSchoolContext;
  cause: unknown;
}> {}

class ReviseError extends Data.TaggedError('ReviseError')<{
  context: SabbathSchoolContext;
  cause: unknown;
}> {}

enum Action {
  Process = 'process',
  Revise = 'revise',
  Export = 'export',
}

class ActionService extends Effect.Service<ActionService>()('ActionService', {
  effect: Effect.gen(function* () {
    const parse = yield* ParseService;
    const action = yield* parse.command(Action, {
      message: 'Select an action to perform:',
      labels: {
        [Action.Revise]: 'Revise Outlines',
        [Action.Process]: 'Download and Generate Outlines',
        [Action.Export]: 'Export to Apple Notes',
      },
    });
    return {
      action,
    };
  }),
}) {}

class Args extends Effect.Service<Args>()('Args', {
  effect: Effect.gen(function* (_) {
    const parse = yield* ParseService;
    const year = parse
      .flagSchema(
        ['year', 'y'],
        Schema.NumberFromString.pipe(
          Schema.lessThanOrEqualTo(new Date().getFullYear()),
        ),
      )
      .pipe(Option.getOrElse(() => new Date().getFullYear()));

    const quarter = parse
      .flagSchema(
        ['quarter', 'q'],
        Schema.NumberFromString.pipe(
          Schema.greaterThanOrEqualTo(1),
          Schema.lessThanOrEqualTo(4),
        ),
      )
      .pipe(Option.getOrElse(() => Math.floor(new Date().getMonth() / 3) + 1));

    const week = parse.flagSchema(
      ['week', 'w'],
      Schema.NumberFromString.pipe(
        Schema.greaterThanOrEqualTo(1),
        Schema.lessThanOrEqualTo(13),
      ),
    );

    return { year, quarter, week } as const;
  }),
}) {}

const outputDir = path.join(process.cwd(), 'outputs', 'sabbath-school');

interface WeekFiles {
  lessonPdf: string;
  egwPdf: string;
}

interface WeekUrls {
  weekNumber: number;
  files: WeekFiles;
}

interface SabbathSchoolContext {
  year: number;
  quarter: number;
  week: number;
}

const findQuarterUrls = Effect.fn('findQuarterUrls')(function* (
  year: number,
  quarter: number,
) {
  // Parse the base URL once
  const baseUrl = `https://www.sabbath.school/LessonBook?year=${year}&quarter=${quarter}`;
  const response = yield* Effect.tryPromise({
    try: () =>
      fetch(baseUrl).then((res) => {
        if (!res.ok) {
          throw new Error(`HTTP error! status: ${res.status}`);
        }
        return res.text();
      }),
    catch: (cause: unknown) =>
      new DownloadError({
        week: 0,
        cause,
      }),
  });

  const $ = yield* Effect.try({
    try: () => cheerio.load(response),
    catch: (cause: unknown) =>
      new CheerioError({
        week: 0,
        cause,
      }),
  });
  const weekUrls: WeekUrls[] = [];
  let currentWeek = 1;
  let currentFiles: Partial<WeekFiles> = {};

  // Find all anchor tags with the specific class
  $('a.btn-u.btn-u-sm').each((_, element) => {
    const text = $(element).text().trim();
    const href = $(element).attr('href');

    if (!href) return;

    if (text === 'Lesson PDF') {
      currentFiles.lessonPdf = href;
    } else if (text === 'EGW Notes PDF') {
      currentFiles.egwPdf = href;
    }

    // If we have both files, we've completed a week
    if (currentFiles.lessonPdf && currentFiles.egwPdf) {
      weekUrls.push({
        weekNumber: currentWeek,
        files: {
          lessonPdf: currentFiles.lessonPdf,
          egwPdf: currentFiles.egwPdf,
        },
      });
      currentWeek++;
      currentFiles = {};
    }
  });

  // Validate that we found all weeks
  if (weekUrls.length === 0) {
    return yield* new MissingPdfError({
      quarter,
    });
  }

  return weekUrls;
});

const downloadFile = Effect.fn('downloadFile')(function* (url: string) {
  return yield* Effect.tryPromise({
    try: () =>
      fetch(url).then((res) => {
        if (!res.ok) {
          throw new Error(`HTTP error! status: ${res.status}`);
        }
        return res.arrayBuffer();
      }),
    catch: (cause: unknown) =>
      new DownloadError({
        week: 0, // This will be set by the caller
        cause,
      }),
  });
});

const getFilePath = (year: number, quarter: number, week: number) => {
  return path.join(outputDir, `${year}-Q${quarter}-W${week}.md`);
};

const reviseOutline = Effect.fn('reviseOutline')(function* (
  context: SabbathSchoolContext,
  text: string,
) {
  const model = yield* ModelService;

  yield* Effect.log(`Checking if revision is needed...`);
  const reviewResponse = yield* Effect.tryPromise({
    try: () =>
      generateObject({
        model,
        messages: [
          { role: 'system', content: reviewCheckSystemPrompt },
          { role: 'user', content: reviewCheckUserPrompt(text) },
        ],
        schema: z.object({
          needsRevision: z
            .boolean()
            .describe('Whether the outline needs revision'),
          revisionPoints: z
            .array(z.string())
            .describe(
              'Specific points where the outline FAILS to meet the prompt requirements',
            ),
          comments: z
            .string()
            .optional()
            .describe(
              'Optional: Brief overall comment on the adherence or specific strengths/weaknesses, but keep it concise',
            ),
        }),
      }),
    catch: (cause: unknown) =>
      new ReviewError({
        context,
        cause,
      }),
  });

  const needsRevision = reviewResponse.object.needsRevision;

  yield* Effect.log(`Revision needed: ${needsRevision}`);
  if (!needsRevision) {
    return Option.none<string>();
  }

  yield* Effect.log(`Revising outline...`);

  const revisedOutline = yield* Effect.tryPromise({
    try: () =>
      generateText({
        model,
        messages: [
          { role: 'system', content: outlineSystemPrompt },
          { role: 'system', content: reviseSystemPrompt },
          {
            role: 'user',
            content: reviseUserPrompt(reviewResponse.object, text),
          },
        ],
      }),
    catch: (cause: unknown) =>
      new ReviseError({
        context,
        cause,
      }),
  });

  return Option.some(revisedOutline.text);
});

const generateOutline = Effect.fn('generateOutline')(function* (
  context: {
    year: number;
    quarter: number;
    week: number;
  },
  lessonPdfBuffer: ArrayBuffer,
  egwPdfBuffer: ArrayBuffer,
) {
  const model = yield* ModelService;

  yield* Effect.log(`Generating outline...`);

  const response = yield* Effect.tryPromise({
    try: () =>
      generateText({
        model,
        messages: [
          { role: 'system', content: outlineSystemPrompt },
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: outlineUserPrompt(context),
              },
              {
                type: 'file',
                mimeType: 'application/pdf',
                data: lessonPdfBuffer,
              },
              {
                type: 'file',
                mimeType: 'application/pdf',
                data: egwPdfBuffer,
              },
            ],
          },
        ],
      }),
    catch: (cause: unknown) =>
      new OutlineError({
        context,
        cause,
      }),
  });

  return response.text;
});

const processQuarter = Effect.gen(function* (_) {
  const args = yield* Args;
  const { year, quarter, week } = args;

  yield* Effect.log(
    `Starting download for Q${quarter} ${year}${
      Option.isSome(week) ? ` Week ${week.value}` : ''
    }`,
  );

  const weeks = Option.match(week, {
    onSome: (w) => [w],
    onNone: () => Array.range(1, 13),
  });

  const quarterUrls = yield* findQuarterUrls(year, quarter);

  yield* Effect.log(
    `Found ${quarterUrls.length} missing Sabbath School lessons to download...`,
  );

  const fs = yield* FileSystem.FileSystem;

  const weeksToDownload = yield* Effect.filter(
    weeks,
    (weekNumber) =>
      Effect.gen(function* () {
        const outlinePath = getFilePath(year, quarter, weekNumber);
        const exists = yield* fs.exists(outlinePath);
        return !exists;
      }),
    {
      concurrency: 'unbounded',
    },
  ).pipe(
    Effect.map((weeks) =>
      weeks.map((weekNumber) =>
        Option.fromNullable(
          quarterUrls.find((urls) => urls.weekNumber === weekNumber),
        ),
      ),
    ),
    Effect.map(
      Option.reduceCompact([] as WeekUrls[], (acc, week) => [...acc, week]),
    ),
  );

  if (weeksToDownload.length === 0) {
    yield* Effect.log('All Sabbath School lessons are already downloaded!');
    return;
  }

  yield* Effect.log(
    `Found ${weeksToDownload.length} missing Sabbath School lessons to download...`,
  );

  yield* Stream.fromIterable(weeksToDownload).pipe(
    Stream.mapEffect(
      (urls) =>
        Effect.gen(function* () {
          yield* Effect.log(`Downloading PDFs...`);
          const [lessonPdf, egwPdf] = yield* Effect.all([
            downloadFile(urls.files.lessonPdf),
            downloadFile(urls.files.egwPdf),
          ]);

          let outline = yield* generateOutline(
            { year, quarter, week: urls.weekNumber },
            lessonPdf,
            egwPdf,
          );

          const revision = yield* reviseOutline(
            { year, quarter, week: urls.weekNumber },
            outline,
          );

          outline = Option.match(revision, {
            onSome: (text) => text,
            onNone: () => outline,
          });

          yield* Effect.log(
            `Writing outline to disk and exporting to Apple Notes...`,
          );
          yield* fs.writeFile(
            getFilePath(year, quarter, urls.weekNumber),
            new TextEncoder().encode(outline),
          );
          yield* Effect.log(`Outline written to disk`);
        }).pipe(
          Effect.annotateLogs({
            year,
            quarter,
            week: urls.weekNumber,
          }),
        ),
      {
        concurrency: 3,
      },
    ),
    Stream.runDrain,
  );

  yield* Effect.log(`\n✅ Download complete`);
});

const reviseQuarter = Effect.gen(function* (_) {
  const startTime = Date.now();
  const args = yield* Args;
  const { year, quarter, week } = args;

  yield* Effect.log(
    `Starting outline revision for Q${quarter} ${year}${
      Option.isSome(week) ? ` Week ${week.value}` : ''
    }`,
  );

  const weeks = Option.match(week, {
    onSome: (w) => [w],
    onNone: () => Array.range(1, 13),
  });

  const fs = yield* FileSystem.FileSystem;

  const weeksToRevise = yield* Effect.filter(weeks, (weekNumber) =>
    Effect.gen(function* () {
      const outlinePath = getFilePath(year, quarter, weekNumber);
      const exists = yield* fs.exists(outlinePath);
      return exists;
    }),
  );

  if (weeksToRevise.length === 0) {
    yield* Effect.log('No Sabbath School lessons to revise');
    return;
  }

  yield* Effect.forEach(
    weeksToRevise,
    (weekNumber, index) =>
      Effect.gen(function* () {
        const outlinePath = getFilePath(year, quarter, weekNumber);
        const outline = yield* fs.readFile(outlinePath);
        const outlineText = new TextDecoder().decode(outline);
        const revisedOutline = yield* reviseOutline(
          { year, quarter, week: weekNumber },
          outlineText,
        );

        yield* Option.match(revisedOutline, {
          onSome: (text) =>
            fs
              .writeFile(outlinePath, new TextEncoder().encode(text))
              .pipe(
                Effect.tap(() =>
                  Effect.log(`Outline for week ${weekNumber} revised`),
                ),
              ),
          onNone: () => Effect.log(`No revision needed for week ${weekNumber}`),
        });
      }).pipe(
        Effect.annotateLogs({
          year,
          quarter,
          week: weekNumber,
          total: weeks.length,
          current: index + 1,
        }),
      ),
    { concurrency: 3 },
  );

  const totalTime = msToMinutes(Date.now() - startTime);
  yield* Effect.log(`\n✅ Revision complete (${totalTime})`);
});

const exportQuarter = Effect.gen(function* (_) {
  const args = yield* Args;
  const { year, quarter, week } = args;

  yield* Effect.log(
    `Starting outline export for Q${quarter} ${year}${
      Option.isSome(week) ? ` Week ${week.value}` : ''
    }`,
  );

  const weeks = Option.match(week, {
    onSome: (w) => [w],
    onNone: () => Array.range(1, 13),
  });

  const fs = yield* FileSystem.FileSystem;

  const weeksToExport = yield* Effect.filter(weeks, (weekNumber) =>
    Effect.gen(function* () {
      const outlinePath = getFilePath(year, quarter, weekNumber);
      const exists = yield* fs.exists(outlinePath);
      return exists;
    }),
  );

  if (weeksToExport.length === 0) {
    yield* Effect.log('No Sabbath School lessons to export');
    return;
  }

  yield* Effect.forEach(weeksToExport, (weekNumber, index) =>
    Effect.gen(function* () {
      const outlinePath = getFilePath(year, quarter, weekNumber);
      const outline = yield* fs.readFile(outlinePath);
      const outlineText = new TextDecoder().decode(outline);
      yield* Effect.log(`Exporting outline to Apple Notes...`);
      yield* makeAppleNoteFromMarkdown(outlineText, {
        activateNotesApp: false,
      });
      yield* Effect.log(`Outline exported to Apple Notes`);
    }).pipe(
      Effect.annotateLogs({
        year,
        quarter,
        week: weekNumber,
        total: weeks.length,
        current: index + 1,
      }),
    ),
  );
});

const program = Effect.gen(function* (_) {
  const { action } = yield* ActionService;

  return yield* Match.value(action).pipe(
    Match.when(Action.Process, () => processQuarter),
    Match.when(Action.Revise, () => reviseQuarter),
    Match.when(Action.Export, () => exportQuarter),
    Match.exhaustive,
  );
});

export const main = program.pipe(
  Effect.provide(ActionService.Default),
  Effect.provide(Args.Default),
  Effect.provide(ModelService.Default),
);
