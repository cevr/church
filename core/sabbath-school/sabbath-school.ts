import * as path from "path";
import { Effect, Schema, Option, Match, Data, Array, Stream } from "effect";
import { FileSystem } from "@effect/platform";

import { generateText, generateObject } from "ai";
import { select, isCancel } from "@clack/prompts";
import * as cheerio from "cheerio";
import { makeAppleNoteFromMarkdown } from "../../lib/markdown-to-notes";

import dotenv from "dotenv";
import {
  outlineSystemPrompt,
  outlineUserPrompt,
  reviewCheckSystemPrompt,
  reviewCheckUserPrompt,
  reviewUserPrompt,
} from "./prompts";
import { z } from "zod";
import { Parse } from "~/core/parse";
import { Model } from "../model";
import { msToMinutes } from "../lib";

dotenv.config();

class OutlineError extends Data.TaggedError("OutlineError")<{
  context: SabbathSchoolContext;
  cause: unknown;
}> {}

class DownloadError extends Data.TaggedError("DownloadError")<{
  week: number;
  cause: unknown;
}> {}

class CheerioError extends Data.TaggedError("CheerioError")<{
  week: number;
  cause: unknown;
}> {}

class MissingPdfError extends Data.TaggedError("MissingPdfError")<{
  week: number;
  missingFiles: string[];
}> {}

class ArgumentError extends Data.TaggedError("ArgumentError")<{
  message: string;
  cause: unknown;
}> {}

class ReviewError extends Data.TaggedError("ReviewError")<{
  context: SabbathSchoolContext;
  cause: unknown;
}> {}

class ReviseError extends Data.TaggedError("ReviseError")<{
  context: SabbathSchoolContext;
  cause: unknown;
}> {}

enum Action {
  Process = "process",
  Revise = "revise",
  Export = "export",
}

class ActionService extends Effect.Service<ActionService>()("ActionService", {
  effect: Effect.gen(function* () {
    const parse = yield* Parse;
    const action = yield* parse.command(Action);
    return {
      action: yield* Option.match(action, {
        onSome: Effect.succeed,
        onNone: () =>
          Effect.gen(function* () {
            const result = yield* Effect.tryPromise({
              try: () =>
                select({
                  message: "Select an action to perform:",
                  options: [
                    { value: Action.Revise, label: "Revise Outlines" },
                    {
                      value: Action.Process,
                      label: "Download and Generate Outlines",
                    },
                    { value: Action.Export, label: "Export to Apple Notes" },
                  ],
                }),
              catch: (cause: unknown) =>
                new ArgumentError({
                  message: `Failed to select action: ${cause}`,
                  cause,
                }),
            });

            if (isCancel(result)) {
              return yield* Effect.die("Action selection cancelled");
            }

            return result as Action;
          }),
      }),
    };
  }),
}) {}

class Args extends Effect.Service<Args>()("Args", {
  effect: Effect.gen(function* (_) {
    const parse = yield* Parse;
    const year = yield* parse
      .flagSchema(
        ["year", "y"],
        Schema.NumberFromString.pipe(
          Schema.lessThanOrEqualTo(new Date().getFullYear())
        )
      )
      .pipe(Effect.map(Option.getOrElse(() => new Date().getFullYear())));

    const quarter = yield* parse
      .flagSchema(
        ["quarter", "q"],
        Schema.NumberFromString.pipe(
          Schema.greaterThanOrEqualTo(1),
          Schema.lessThanOrEqualTo(4)
        )
      )
      .pipe(
        Effect.map(
          Option.getOrElse(() => Math.floor(new Date().getMonth() / 3) + 1)
        )
      );

    const week = yield* parse.flagSchema(
      ["week", "w"],
      Schema.NumberFromString.pipe(
        Schema.greaterThanOrEqualTo(1),
        Schema.lessThanOrEqualTo(13)
      )
    );

    return { year, quarter, week } as const;
  }),
}) {}

const outputDir = path.join(process.cwd(), "outputs", "sabbath-school");

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

const findWeekUrls = (year: number, quarter: number) =>
  Effect.gen(function* (_) {
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
    $("a.btn-u.btn-u-sm").each((_, element) => {
      const text = $(element).text().trim();
      const href = $(element).attr("href");

      if (!href) return;

      if (text === "Lesson PDF") {
        currentFiles.lessonPdf = href;
      } else if (text === "EGW Notes PDF") {
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
        week: 1,
        missingFiles: ["Lesson PDF", "EGW Notes PDF"],
      });
    }

    return weekUrls;
  });

const downloadFile = (url: string) =>
  Effect.tryPromise({
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

const getFilePath = (year: number, quarter: number, week: number) =>
  path.join(outputDir, `${year}-Q${quarter}-W${week}.md`);

const reviseOutline = (context: SabbathSchoolContext, text: string) =>
  Effect.gen(function* (_) {
    const model = yield* Model;

    yield* Effect.log(`Checking if revision is needed...`);
    const reviewResponse = yield* Effect.tryPromise({
      try: () =>
        generateObject({
          model,
          messages: [
            { role: "system", content: reviewCheckSystemPrompt },
            { role: "user", content: reviewCheckUserPrompt(text) },
          ],
          schema: z.object({
            needsRevision: z
              .boolean()
              .describe("Whether the outline needs revision"),
            revisionPoints: z
              .array(z.string())
              .describe(
                "Specific points where the outline FAILS to meet the prompt requirements"
              ),
            comments: z
              .string()
              .optional()
              .describe(
                "Optional: Brief overall comment on the adherence or specific strengths/weaknesses, but keep it concise"
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
            { role: "system", content: reviewCheckSystemPrompt },
            {
              role: "user",
              content: reviewUserPrompt(reviewResponse.object, text),
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

const generateOutline = (
  context: {
    year: number;
    quarter: number;
    week: number;
  },
  lessonPdfBuffer: ArrayBuffer,
  egwPdfBuffer: ArrayBuffer
) =>
  Effect.gen(function* (_) {
    const model = yield* Model;

    yield* Effect.log(`Generating outline...`);

    const response = yield* Effect.tryPromise({
      try: () =>
        generateText({
          model,
          messages: [
            { role: "system", content: outlineSystemPrompt },
            {
              role: "user",
              content: [
                {
                  type: "text",
                  text: outlineUserPrompt(context),
                },
                {
                  type: "file",
                  mimeType: "application/pdf",
                  data: lessonPdfBuffer,
                },
                {
                  type: "file",
                  mimeType: "application/pdf",
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
  }).pipe(Effect.withLogSpan("Generate outline"));

const processQuarter = Effect.gen(function* (_) {
  const args = yield* Args;
  const { year, quarter, week } = args;

  yield* Effect.log(
    `Starting download for Q${quarter} ${year}${
      Option.isSome(week) ? ` Week ${week.value}` : ""
    }`
  );

  const weeks = Option.match(week, {
    onSome: (w) => [w],
    onNone: () => Array.range(1, 13),
  });

  const weekUrls = yield* findWeekUrls(year, quarter);

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
      concurrency: "unbounded",
    }
  ).pipe(
    Effect.map((weeks) =>
      weeks.map((weekNumber) =>
        Option.fromNullable(
          weekUrls.find((urls) => urls.weekNumber === weekNumber)
        )
      )
    ),
    Effect.map(
      Option.reduceCompact([] as WeekUrls[], (acc, week) => [...acc, week])
    )
  );

  if (weeksToDownload.length === 0) {
    yield* Effect.log("All Sabbath School lessons are already downloaded!");
    return;
  }

  yield* Effect.log(
    `Found ${weeksToDownload.length} missing Sabbath School lessons to download...`
  );

  yield* Stream.fromIterable(weeksToDownload).pipe(
    Stream.mapEffect(
      (urls) =>
        Effect.gen(function* () {
          Effect.log(`Downloading PDFs...`);
          const [lessonPdf, egwPdf] = yield* Effect.all([
            downloadFile(urls.files.lessonPdf),
            downloadFile(urls.files.egwPdf),
          ]);

          let outline = yield* generateOutline(
            { year, quarter, week: urls.weekNumber },
            lessonPdf,
            egwPdf
          );

          const revision = yield* reviseOutline(
            { year, quarter, week: urls.weekNumber },
            outline
          );

          outline = Option.getOrElse(revision, () => outline);

          yield* Effect.log(
            `Writing outline to disk and exporting to Apple Notes...`
          );
          yield* Effect.all([
            fs.writeFile(
              getFilePath(year, quarter, urls.weekNumber),
              new TextEncoder().encode(outline)
            ),
            makeAppleNoteFromMarkdown(outline, {
              activateNotesApp: false,
            }),
          ]);
          yield* Effect.log(
            `Outline written to disk and exported to Apple Notes`
          );
        }).pipe(
          Effect.withLogSpan("Download and generate outline"),
          Effect.annotateLogs({
            year,
            quarter,
            week: urls.weekNumber,
          })
        ),
      {
        concurrency: 3,
      }
    ),
    Stream.runDrain
  );

  yield* Effect.log(`\n✅ Download complete`);
}).pipe(Effect.withLogSpan("Download and generate outlines"));

const reviseQuarter = Effect.gen(function* (_) {
  const startTime = Date.now();
  const args = yield* Args;
  const { year, quarter, week } = args;

  yield* Effect.log(
    `Starting outline revision for Q${quarter} ${year}${
      Option.isSome(week) ? ` Week ${week.value}` : ""
    }`
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
    })
  );

  if (weeksToRevise.length === 0) {
    yield* Effect.log("No Sabbath School lessons to revise");
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
          outlineText
        );

        yield* Option.match(revisedOutline, {
          onSome: (text) =>
            fs
              .writeFile(outlinePath, new TextEncoder().encode(text))
              .pipe(
                Effect.tap(() =>
                  Effect.log(`Outline for week ${weekNumber} revised`)
                )
              ),
          onNone: () => Effect.log(`No revision needed for week ${weekNumber}`),
        });
      }).pipe(
        Effect.withLogSpan("Revise outline"),
        Effect.annotateLogs({
          year,
          quarter,
          week: weekNumber,
          total: weeks.length,
          current: index + 1,
        })
      ),
    { concurrency: 3 }
  );

  const totalTime = msToMinutes(Date.now() - startTime);
  yield* Effect.log(`\n✅ Revision complete (${totalTime})`);
});

const exportQuarter = Effect.gen(function* (_) {
  const args = yield* Args;
  const { year, quarter, week } = args;

  yield* Effect.log(
    `Starting outline export for Q${quarter} ${year}${
      Option.isSome(week) ? ` Week ${week.value}` : ""
    }`
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
    })
  );

  if (weeksToExport.length === 0) {
    yield* Effect.log("No Sabbath School lessons to export");
    return;
  }

  yield* Effect.forEach(
    weeksToExport,
    (weekNumber, index) =>
      Effect.gen(function* () {
        const outlinePath = getFilePath(year, quarter, weekNumber);
        const outline = yield* fs.readFile(outlinePath);
        const outlineText = new TextDecoder().decode(outline);
        yield* makeAppleNoteFromMarkdown(outlineText, {
          activateNotesApp: false,
        });
      }).pipe(
        Effect.withLogSpan("Export outline"),
        Effect.annotateLogs({
          year,
          quarter,
          week: weekNumber,
          total: weeks.length,
          current: index + 1,
        })
      ),
    { concurrency: "unbounded" }
  );
}).pipe(Effect.withLogSpan("Export outline"));

const program = Effect.gen(function* (_) {
  const { action } = yield* ActionService;

  return yield* Match.value(action).pipe(
    Match.when(Action.Process, () => processQuarter),
    Match.when(Action.Revise, () => reviseQuarter),
    Match.when(Action.Export, () => exportQuarter),
    Match.exhaustive
  );
});

export const main = program.pipe(
  Effect.provide(ActionService.Default),
  Effect.provide(Args.Default),
  Effect.provide(Model.Default)
);
