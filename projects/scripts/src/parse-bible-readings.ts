#!/usr/bin/env bun
import { Args, Command } from '@effect/cli';
import { FileSystem, Path } from '@effect/platform';
import { BunContext, BunRuntime } from '@effect/platform-bun';
import {
  BadArgument,
  PlatformError,
  SystemError,
} from '@effect/platform/Error';
import { Effect } from 'effect';
import { PDFParse } from 'pdf-parse';

// Dynamic import for pdf-parse to handle module resolution
type PdfParseFunction = (
  dataBuffer: Buffer,
) => Promise<{ text: string; numpages: number }>;

const PdfPathArg = Args.file({
  name: 'pdf-path',
}).pipe(
  Args.withDescription(
    'Path to the PDF file to parse (or .txt file for testing)',
  ),
);

const OutputDirOption = Args.directory({
  name: 'output-dir',
}).pipe(
  Args.withDefault('./extracted-chapters'),
  Args.withDescription('Directory where chapter files will be created'),
);

// Schema for chapter data
type Chapter = {
  number: number;
  title: string;
  content: string;
};

// Error types
class PdfParseError extends Error {
  readonly _tag = 'PdfParseError';
  constructor(
    message: string,
    public cause: unknown,
  ) {
    super(message);
  }
}

class ChapterExtractionError extends Error {
  readonly _tag = 'ChapterExtractionError';
  constructor(
    message: string,
    public cause: unknown,
  ) {
    super(message);
  }
}

class FileWriteError extends Error {
  readonly _tag = 'FileWriteError';
  constructor(
    message: string,
    public cause: unknown,
    public filePath: string,
  ) {
    super(message);
  }
}

// Real PDF parsing function using pdf-parse (also supports text files for testing)
const parsePdfContent = Effect.fn('parsePdfContent')(function* (
  filePath: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const data = yield* fs.readFile(filePath);
  const parser = new PDFParse({
    data: data,
  });
  return yield* Effect.tryPromise({
    try: () => parser.getText(),
    catch: (cause) => new PdfParseError('Failed to parse file', cause),
  }).pipe(Effect.map((text) => text.text));
});

// specifically things like "Chapter 1" or "CHAPTER 1"
const chapterPattern = /Chapter\s+(\d+)/gi;

// Clean page numbers from content
const cleanPageNumbers = (content: string): string => {
  return content
    .split('\n')
    .filter((line) => {
      const trimmed = line.trim();
      // Remove lines matching "-- X of Y --" pattern
      if (/^--\s+\d+\s+of\s+\d+\s+--$/.test(trimmed)) {
        return false;
      }
      // Remove standalone numbers (likely page numbers)
      if (/^\d+$/.test(trimmed)) {
        return false;
      }
      return true;
    })
    .join('\n');
};

// Extract chapters from text content
const extractChapters = Effect.fn('extractChapters')(function* (
  content: string,
) {
  return yield* Effect.try({
    try: () => {
      const chapters: Chapter[] = [];
      const matches = Array.from(content.matchAll(chapterPattern));

      // Sort matches by position in text
      matches.sort((a, b) => a.index! - b.index!);

      // Remove duplicates at the same position
      const uniqueMatches = matches.filter(
        (match, index, array) =>
          index === 0 || match.index !== array[index - 1].index,
      );

      for (let i = 0; i < uniqueMatches.length; i++) {
        const match = uniqueMatches[i];
        const startIndex = match.index!;
        const endIndex =
          i < uniqueMatches.length - 1
            ? uniqueMatches[i + 1].index!
            : content.length;
        let chapterContent = content.slice(startIndex, endIndex).trim();

        // Clean page numbers from chapter content
        chapterContent = cleanPageNumbers(chapterContent);

        // Extract chapter number (match[1] is always numeric due to pattern)
        const chapterNumber = parseInt(match[1]!);
        const chapterTitle = `Chapter ${chapterNumber}`;

        chapters.push({
          number: chapterNumber,
          title: chapterTitle,
          content: chapterContent,
        });
      }

      // If no chapters found, treat entire content as one chapter
      if (chapters.length === 0) {
        chapters.push({
          number: 1,
          title: 'Chapter 1',
          content: cleanPageNumbers(content.trim()),
        });
      }

      return chapters.sort((a, b) => a.number - b.number);
    },
    catch: (cause) =>
      new ChapterExtractionError('Failed to extract chapters', cause),
  });
});

// Extract title and clean duplicate chapter header from content
const extractTitleAndCleanContent = (
  content: string,
  chapterNumber: number,
): { title: string; cleanedContent: string } => {
  const lines = content.split('\n');
  const chapterHeaderPattern = new RegExp(`^Chapter\\s+${chapterNumber}$`, 'i');

  // The content starts with "Chapter X" (the match), followed by the title
  // Extract the title and remove the duplicate chapter header
  let title = `Chapter ${chapterNumber}`;
  let startIndex = 0;

  // Check if first line is the chapter header
  if (lines.length > 0 && chapterHeaderPattern.test(lines[0].trim())) {
    // Check if next line is the title
    if (lines.length > 1 && lines[1].trim()) {
      const potentialTitle = lines[1].trim();
      // If it's not another chapter header, it's the title
      if (!chapterHeaderPattern.test(potentialTitle)) {
        title = potentialTitle;
        startIndex = 2; // Skip both chapter header and title lines
      } else {
        startIndex = 1; // Skip only the chapter header
      }
    } else {
      startIndex = 1; // Skip the chapter header
    }
  }

  const cleanedLines = lines.slice(startIndex);
  const cleanedContent = cleanedLines
    .join('\n')
    .replace(/\n\s*\n\s*\n/g, '\n\n') // Remove triple+ line breaks
    .replace(/[\r\n]+/g, '\n') // Normalize line endings
    .trim();

  return { title, cleanedContent };
};

// Write chapter to file with better formatting
const writeChapterFile = Effect.fn('writeChapterFile')(function* (
  chapter: Chapter,
  outputDir: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const fileName = `chapter-${chapter.number.toString().padStart(2, '0')}.txt`;
  const filePath = path.join(outputDir, fileName);

  // Extract title and clean duplicate chapter header
  const { title, cleanedContent } = extractTitleAndCleanContent(
    chapter.content,
    chapter.number,
  );

  // Format: Chapter Number, Title, Divider, Content
  const divider = '='.repeat(Math.max(title.length, chapter.title.length));
  const content = `${chapter.title}\n${title}\n${divider}\n\n${cleanedContent}`;

  yield* fs
    .writeFile(filePath, new TextEncoder().encode(content))
    .pipe(
      Effect.catchAll((cause) =>
        Effect.fail(
          new FileWriteError('Failed to write chapter file', cause, filePath),
        ),
      ),
    );

  console.log(`✓ Created: ${fileName}`);
});

// Main processing function with progress tracking
const processPdf = Effect.fn('processPdf')(function* (
  pdfPath: string,
  outputDir: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  // Validate input file exists
  const fileExists = yield* fs.exists(pdfPath);
  if (!fileExists) {
    yield* Effect.fail(
      new PdfParseError(
        `PDF file not found: ${pdfPath}`,
        new Error('File not found'),
      ),
    );
  }

  // Ensure output directory exists
  yield* fs.makeDirectory(outputDir, { recursive: true });

  console.log(`📖 Parsing PDF: ${pdfPath}`);
  const content = yield* parsePdfContent(pdfPath);

  console.log('🔍 Extracting chapters...');
  const chapters = yield* extractChapters(content);

  console.log(`📚 Found ${chapters.length} chapters`);

  // Write chapter files with progress
  console.log('💾 Saving chapter files...');
  yield* Effect.forEach(
    chapters,
    (chapter) => writeChapterFile(chapter, outputDir),
    { concurrency: 1, discard: true }, // Sequential processing for better progress tracking
  );

  console.log(
    `✅ Successfully extracted ${chapters.length} chapters to ${outputDir}`,
  );
  console.log(`📂 Output directory: ${path.resolve(outputDir)}`);
});

// Create the CLI command with better error handling
const parseBibleReadings = Command.make(
  'parse-bible-readings',
  {
    pdfPath: PdfPathArg,
    outputDir: OutputDirOption,
  },
  (args) =>
    processPdf(args.pdfPath, args.outputDir).pipe(
      Effect.catchTag('PdfParseError', (error) =>
        Effect.sync(() =>
          console.error(`❌ PDF Parse Error: ${error.message}`),
        ),
      ),
      Effect.catchTag('ChapterExtractionError', (error) =>
        Effect.sync(() =>
          console.error(`❌ Chapter Extraction Error: ${error.message}`),
        ),
      ),
      Effect.catchTag('FileWriteError', (error) =>
        Effect.sync(() =>
          console.error(
            `❌ File Write Error: ${error.message} - ${error.filePath}`,
          ),
        ),
      ),
      Effect.catchAll((error) =>
        Effect.sync(() => console.error(`❌ Unexpected error:`, error)),
      ),
    ),
);

// Run the CLI
const cli = Command.run(parseBibleReadings, {
  name: 'Parse Bible Readings',
  version: 'v1.0.0',
});

cli(process.argv).pipe(Effect.provide(BunContext.layer), BunRuntime.runMain);
