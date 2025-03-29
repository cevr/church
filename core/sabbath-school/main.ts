import * as fs from "fs";
import * as path from "path";
import { Effect, Schema, Option, Match, Data } from "effect";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { generateText, generateObject } from "ai";
import { select, isCancel } from "@clack/prompts";
import { matchSorter } from "match-sorter";
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
import { parseFlag } from "../parse";

dotenv.config();

const LESSON_PDF_FILENAME = "lesson.pdf";
const EGW_PDF_FILENAME = "egw.pdf";

class OutlineError extends Data.TaggedError("OutlineError")<{
  week: number;
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

class FileSystemError extends Data.TaggedError("FileSystemError")<{
  operation: string;
  cause: unknown;
}> {}

class ReviewError extends Data.TaggedError("ReviewError")<{
  week: number;
  cause: unknown;
}> {}

class ReviseError extends Data.TaggedError("ReviseError")<{
  week: number;
  cause: unknown;
}> {}

class Model extends Effect.Service<Model>()("Model", {
  effect: Effect.gen(function* (_) {
    const key = yield* Schema.Config("GEMINI_API_KEY", Schema.NonEmptyString);
    const model = createGoogleGenerativeAI({
      apiKey: key,
    })("gemini-2.5-pro-exp-03-25");

    return model;
  }),
}) {}

const parseYear = parseFlag("--year").pipe(
  Effect.map((x) =>
    x.pipe(
      Option.map(
        Schema.decodeUnknownSync(
          Schema.NumberFromString.pipe(
            Schema.lessThanOrEqualTo(new Date().getFullYear())
          )
        )
      ),
      Option.getOrElse(() => new Date().getFullYear())
    )
  )
);

const parseQuarter = parseFlag("--quarter").pipe(
  Effect.map((x) =>
    x.pipe(
      Option.map(
        Schema.decodeUnknownSync(
          Schema.NumberFromString.pipe(
            Schema.greaterThanOrEqualTo(1),
            Schema.lessThanOrEqualTo(4)
          )
        )
      ),
      Option.getOrElse(() => Math.floor(new Date().getMonth() / 3) + 1)
    )
  )
);

const parseWeek = parseFlag("--week").pipe(
  Effect.map((x) =>
    x.pipe(
      Option.map(
        Schema.decodeUnknownSync(
          Schema.NumberFromString.pipe(
            Schema.greaterThanOrEqualTo(1),
            Schema.lessThanOrEqualTo(13)
          )
        )
      )
    )
  )
);

enum Action {
  Outline = "outline",
  Download = "download",
  Revise = "revise",
  Export = "export",
}

const parseAction = parseFlag("--action").pipe(
  Effect.map((x) =>
    x.pipe(
      Option.flatMap((action) =>
        Option.fromNullable(
          matchSorter(
            [Action.Outline, Action.Download, Action.Revise, Action.Export],
            action
          )[0] as string | undefined
        )
      ),
      Option.map(Schema.decodeUnknownSync(Schema.Enums(Action)))
    )
  )
);

class Args extends Effect.Service<Args>()("Args", {
  effect: Effect.gen(function* (_) {
    const year = yield* parseYear;
    const quarter = yield* parseQuarter;
    const action = yield* parseAction;
    const week = yield* parseWeek;

    return { year, quarter, action, week } as const;
  }),
}) {}

const ensureDir = (dir: string) =>
  Effect.gen(function* () {
    const exists = yield* fileExists(dir);
    if (!exists) {
      yield* Effect.log(`Creating directory: ${dir}`);
      yield* Effect.try({
        try: () => fs.mkdirSync(dir, { recursive: true }),
        catch: (cause: unknown) =>
          new FileSystemError({
            operation: "create_dir",
            cause,
          }),
      });
    }
  });

const getWeekDir = (weekNumber: number, quarter: number, year: number) =>
  path.join(
    process.cwd(),
    "outputs",
    "sabbath-school",
    year.toString(),
    `quarter-${quarter}`,
    `week-${weekNumber}`
  );

const fileExists = (path: string) =>
  Effect.try({
    try: () => fs.existsSync(path),
    catch: (cause: unknown) =>
      new FileSystemError({
        operation: "check_file_exists",
        cause,
      }),
  });

const formatLogPrefix = (
  current: number,
  total: number,
  year: number,
  quarter: number,
  week: number
) =>
  `[${current.toString().padStart(2, "0")}/${total
    .toString()
    .padStart(2, "0")}][${year}][Q${quarter}][W${week
    .toString()
    .padStart(2, "0")}] - `;

interface WeekFiles {
  lessonPdf: string;
  egwPdf: string;
}

interface WeekUrls {
  weekNumber: number;
  files: WeekFiles;
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

const downloadFile = (url: string, path: string) =>
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
  }).pipe(
    Effect.flatMap((buffer) =>
      Effect.try({
        try: () => fs.writeFileSync(path, Buffer.from(buffer)),
        catch: (cause: unknown) =>
          new FileSystemError({
            operation: "write_file",
            cause,
          }),
      })
    )
  );

const downloadQuarter = Effect.gen(function* (_) {
  const startTime = Date.now();
  const args = yield* Args;
  const { year, quarter, week } = args;

  yield* Effect.log(
    `Starting download for Q${quarter} ${year}${
      Option.isSome(week) ? ` Week ${week.value}` : ""
    }`
  );

  const weeks = Option.match(week, {
    onSome: (w) => [w],
    onNone: () => Array.from({ length: 13 }, (_, i) => i + 1),
  });

  // Get all available week URLs
  const weekUrls = yield* findWeekUrls(year, quarter);

  // Filter weeks based on what we need to download
  const weeksToDownload = weeks.filter((weekNumber) => {
    const weekDir = getWeekDir(weekNumber, quarter, year);
    const lessonPdfPath = path.join(weekDir, LESSON_PDF_FILENAME);
    const egwPdfPath = path.join(weekDir, EGW_PDF_FILENAME);
    return !fs.existsSync(lessonPdfPath) || !fs.existsSync(egwPdfPath);
  });

  if (weeksToDownload.length === 0) {
    yield* Effect.log("All PDFs are already downloaded!");
    return;
  }

  yield* Effect.log(
    `Found ${weeksToDownload.length} missing PDFs to download...`
  );

  yield* Effect.forEach(
    weeksToDownload,
    (weekNumber, index) =>
      Effect.gen(function* (_) {
        const weekUrl = weekUrls.find((w) => w.weekNumber === weekNumber);
        if (!weekUrl) {
          yield* Effect.log(
            `${formatLogPrefix(
              index + 1,
              weeksToDownload.length,
              year,
              quarter,
              weekNumber
            )}No URLs found for this week, skipping...`
          );
          return;
        }

        const weekDir = getWeekDir(weekNumber, quarter, year);
        const lessonPdfPath = path.join(weekDir, LESSON_PDF_FILENAME);
        const egwPdfPath = path.join(weekDir, EGW_PDF_FILENAME);

        yield* ensureDir(weekDir);

        const downloads: ReturnType<typeof downloadFile>[] = [];
        if (!fs.existsSync(lessonPdfPath)) {
          downloads.push(downloadFile(weekUrl.files.lessonPdf, lessonPdfPath));
        }
        if (!fs.existsSync(egwPdfPath)) {
          downloads.push(downloadFile(weekUrl.files.egwPdf, egwPdfPath));
        }

        if (downloads.length > 0) {
          yield* Effect.all(downloads);
        }

        yield* Effect.log(
          `${formatLogPrefix(
            index + 1,
            weeksToDownload.length,
            year,
            quarter,
            weekNumber
          )}Files downloaded`
        );
      }),
    { concurrency: 5 }
  );

  const totalTime = msToMinutes(Date.now() - startTime);
  yield* Effect.log(`\n✅ Download complete (${totalTime})`);
});

const reviseText = (
  text: string,
  weekNumber: number,
  current: number,
  total: number,
  year: number,
  quarter: number
) =>
  Effect.gen(function* (_) {
    const model = yield* Model;

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
          week: weekNumber,
          cause,
        }),
    });

    const needsRevision = reviewResponse.object.needsRevision;

    if (!needsRevision) {
      yield* Effect.log(
        `${formatLogPrefix(
          current,
          total,
          year,
          quarter,
          weekNumber
        )}No revision needed`
      );
      return text;
    }

    yield* Effect.log(
      `${formatLogPrefix(
        current,
        total,
        year,
        quarter,
        weekNumber
      )}Revising outline...`
    );

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
          week: weekNumber,
          cause,
        }),
    });

    return revisedOutline.text;
  });

const generateOutline = (
  weekNumber: number,
  quarter: number,
  year: number,
  current: number,
  total: number
) =>
  Effect.gen(function* (_) {
    const startTime = Date.now();
    const weekDir = getWeekDir(weekNumber, quarter, year);
    const model = yield* Model;
    const lessonPdfPath = path.join(weekDir, LESSON_PDF_FILENAME);
    const egwPdfPath = path.join(weekDir, EGW_PDF_FILENAME);

    yield* Effect.log(
      `${formatLogPrefix(
        current,
        total,
        year,
        quarter,
        weekNumber
      )}Reading PDFs...`
    );

    const [lessonPdfBuffer, egwPdfBuffer] = yield* Effect.all([
      Effect.try({
        try: () => fs.readFileSync(lessonPdfPath),
        catch: (cause: unknown) =>
          new FileSystemError({
            operation: "read_file",
            cause,
          }),
      }),
      Effect.try({
        try: () => fs.readFileSync(egwPdfPath),
        catch: (cause: unknown) =>
          new FileSystemError({
            operation: "read_file",
            cause,
          }),
      }),
    ]);

    const outlineStartTime = Date.now();

    yield* Effect.log(
      `${formatLogPrefix(
        current,
        total,
        year,
        quarter,
        weekNumber
      )}Generating outline...`
    );

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
                  text: outlineUserPrompt(year, quarter, weekNumber),
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
          week: weekNumber,
          cause,
        }),
    });

    yield* Effect.log(
      `${formatLogPrefix(
        current,
        total,
        year,
        quarter,
        weekNumber
      )}Outline generated in ${msToMinutes(Date.now() - outlineStartTime)}`
    );

    let text = response.text;

    // Revise the outline if needed
    text = yield* reviseText(text, weekNumber, current, total, year, quarter);

    yield* Effect.log(
      `${formatLogPrefix(
        current,
        total,
        year,
        quarter,
        weekNumber
      )}Writing outline...`
    );
    yield* Effect.try({
      try: () => fs.writeFileSync(path.join(weekDir, "outline.md"), text),
      catch: (cause: unknown) =>
        new FileSystemError({
          operation: "write_file",
          cause,
        }),
    });

    // Export to Apple Notes after writing to disk
    yield* Effect.log(
      `${formatLogPrefix(
        current,
        total,
        year,
        quarter,
        weekNumber
      )}Exporting to Apple Notes...`
    );

    yield* makeAppleNoteFromMarkdown(text, {
      activateNotesApp: false,
    });

    const totalTime = msToMinutes(Date.now() - startTime);
    yield* Effect.log(
      `${formatLogPrefix(
        current,
        total,
        year,
        quarter,
        weekNumber
      )}Outline generated and exported (${totalTime})`
    );
  });

const processQuarter = Effect.gen(function* (_) {
  const startTime = Date.now();
  const args = yield* Args;
  const { year, quarter, week } = args;

  yield* Effect.log(
    `Starting outline generation for Q${quarter} ${year}${
      Option.isSome(week) ? ` Week ${week.value}` : ""
    }`
  );

  const weeks = Option.match(week, {
    onSome: (w) => [w],
    onNone: () => Array.from({ length: 13 }, (_, i) => i + 1),
  });

  yield* Effect.forEach(
    weeks,
    (weekNumber, index) =>
      generateOutline(weekNumber, quarter, year, index + 1, weeks.length),
    { concurrency: 2 }
  );

  const totalTime = msToMinutes(Date.now() - startTime);
  yield* Effect.log(`\n✅ Processing complete (${totalTime})`);
});

const reviseOutline = (
  weekNumber: number,
  quarter: number,
  year: number,
  current: number,
  total: number
) =>
  Effect.gen(function* (_) {
    const startTime = Date.now();
    const weekDir = getWeekDir(weekNumber, quarter, year);
    const outlinePath = path.join(weekDir, "outline.md");

    yield* Effect.log(
      `${formatLogPrefix(
        current,
        total,
        year,
        quarter,
        weekNumber
      )}Reading outline...`
    );

    const outlineText = yield* Effect.try({
      try: () => fs.readFileSync(outlinePath, "utf-8"),
      catch: (cause: unknown) =>
        new FileSystemError({
          operation: "read_file",
          cause,
        }),
    });

    // Revise the outline if needed
    const revisedText = yield* reviseText(
      outlineText,
      weekNumber,
      current,
      total,
      year,
      quarter
    );

    // Only write if the text was actually revised
    if (revisedText !== outlineText) {
      yield* Effect.log(
        `${formatLogPrefix(
          current,
          total,
          year,
          quarter,
          weekNumber
        )}Writing revised outline...`
      );

      yield* Effect.try({
        try: () => fs.writeFileSync(outlinePath, revisedText),
        catch: (cause: unknown) =>
          new FileSystemError({
            operation: "write_file",
            cause,
          }),
      });

      // Export to Apple Notes after writing to disk
      yield* Effect.log(
        `${formatLogPrefix(
          current,
          total,
          year,
          quarter,
          weekNumber
        )}Exporting to Apple Notes...`
      );
      yield* makeAppleNoteFromMarkdown(revisedText, {
        activateNotesApp: false,
      });
    }

    const totalTime = msToMinutes(Date.now() - startTime);
    yield* Effect.log(
      `${formatLogPrefix(
        current,
        total,
        year,
        quarter,
        weekNumber
      )}Outline revised and exported (${totalTime})`
    );
  });

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
    onNone: () => Array.from({ length: 13 }, (_, i) => i + 1),
  });

  yield* Effect.forEach(
    weeks,
    (weekNumber, index) =>
      reviseOutline(weekNumber, quarter, year, index + 1, weeks.length),
    { concurrency: 2 }
  );

  const totalTime = msToMinutes(Date.now() - startTime);
  yield* Effect.log(`\n✅ Revision complete (${totalTime})`);
});

const exportOutline = (
  weekNumber: number,
  quarter: number,
  year: number,
  current: number,
  total: number
) =>
  Effect.gen(function* (_) {
    const startTime = Date.now();
    const weekDir = getWeekDir(weekNumber, quarter, year);
    const outlinePath = path.join(weekDir, "outline.md");

    yield* Effect.log(
      `${formatLogPrefix(
        current,
        total,
        year,
        quarter,
        weekNumber
      )}Reading outline...`
    );

    const outlineText = yield* Effect.try({
      try: () => fs.readFileSync(outlinePath, "utf-8"),
      catch: (cause: unknown) =>
        new FileSystemError({
          operation: "read_file",
          cause,
        }),
    });

    yield* Effect.log(
      `${formatLogPrefix(
        current,
        total,
        year,
        quarter,
        weekNumber
      )}Exporting to Apple Notes...`
    );

    yield* makeAppleNoteFromMarkdown(outlineText, {
      activateNotesApp: false,
    });

    const totalTime = msToMinutes(Date.now() - startTime);
    yield* Effect.log(
      `${formatLogPrefix(
        current,
        total,
        year,
        quarter,
        weekNumber
      )}Outline exported (${totalTime})`
    );
  });

const exportQuarter = Effect.gen(function* (_) {
  const startTime = Date.now();
  const args = yield* Args;
  const { year, quarter, week } = args;

  yield* Effect.log(
    `Starting outline export for Q${quarter} ${year}${
      Option.isSome(week) ? ` Week ${week.value}` : ""
    }`
  );

  const weeks = Option.match(week, {
    onSome: (w) => [w],
    onNone: () => Array.from({ length: 13 }, (_, i) => i + 1),
  });

  yield* Effect.forEach(
    weeks,
    (weekNumber, index) =>
      exportOutline(weekNumber, quarter, year, index + 1, weeks.length),
    { concurrency: 2 }
  );

  const totalTime = msToMinutes(Date.now() - startTime);
  yield* Effect.log(`\n✅ Export complete (${totalTime})`);
});

const program = Effect.gen(function* (_) {
  const args = yield* Args;

  const action = yield* Option.match(args.action, {
    onSome: Effect.succeed,
    onNone: () =>
      Effect.gen(function* () {
        const result = yield* Effect.tryPromise({
          try: () =>
            select({
              message: "Select an action to perform:",
              options: [
                { value: Action.Outline, label: "Generate Outlines" },
                { value: Action.Revise, label: "Revise Outlines" },
                { value: Action.Download, label: "Download Files" },
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
  });

  return yield* Match.value(action).pipe(
    Match.when(Action.Outline, () => processQuarter),
    Match.when(Action.Download, () => downloadQuarter),
    Match.when(Action.Revise, () => reviseQuarter),
    Match.when(Action.Export, () => exportQuarter),
    Match.exhaustive
  );
});

const msToMinutes = (ms: number) => {
  const minutes = Math.floor(ms / 60000);
  const seconds = Math.floor((ms % 60000) / 1000);
  return `${minutes}m:${seconds.toString().padStart(2, "0")}s`;
};

export const main = program.pipe(
  Effect.provide(Args.Default),
  Effect.provide(Model.Default)
);
