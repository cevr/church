/**
 * Sync EGW Paragraphs to Local Database
 *
 * This script fetches all EGW paragraphs from the API and stores them in a local SQLite database.
 * This allows subsequent operations to use cached paragraph data instead of making HTTP calls.
 *
 * Usage:
 *   bun run sync-egw-books.ts [languageCode] [egwAuthorName]
 *
 * Note: This script specifically filters for EGW (Ellen G. White) books only.
 * By default, it uses "Ellen Gould White" as the author name to filter books.
 *
 * Environment Variables Required:
 *   - GOOGLE_AI_API_KEY: Your Google AI API key (not used, but may be required by dependencies)
 *   - EGW_CLIENT_ID: EGW API client ID
 *   - EGW_CLIENT_SECRET: EGW API client secret
 *   - EGW_AUTH_BASE_URL: (optional) Defaults to https://cpanel.egwwritings.org
 *   - EGW_API_BASE_URL: (optional) Defaults to https://a.egwwritings.org
 *   - EGW_SCOPE: (optional) Defaults to "writings search studycenter subscriptions user_info"
 *   - EGW_PARAGRAPH_DB: (optional) Path to paragraph database file, defaults to "data/egw-paragraphs.db"
 */

import { FetchHttpClient } from '@effect/platform';
import { BunContext, BunRuntime } from '@effect/platform-bun';
import { Effect, Layer, Ref, Stream } from 'effect';

import { EGWParagraphDatabase } from '../src/egw-db/index.js';
import { EGWApiClient } from '../src/egw/client.js';

const languageCode = process.argv[2] || 'en';
// Default to Ellen G. White (EGW) - the primary author of EGW writings
const egwAuthorName = process.argv[3] || 'Ellen Gould White';

const program = Effect.gen(function* () {
  const paragraphDb = yield* EGWParagraphDatabase;
  const egwClient = yield* EGWApiClient;

  yield* Effect.log(
    `Starting sync of EGW paragraphs to local database (language: ${languageCode}, author: ${egwAuthorName})...`,
  );

  // Fetch all books from API as a stream and filter to only EGW books
  yield* Effect.log(`Fetching books from EGW API...`);

  // Create Refs to track statistics as we process the stream
  const totalBooksRef = yield* Ref.make(0);
  const booksProcessedRef = yield* Ref.make(0);
  const storedParagraphsRef = yield* Ref.make(0);
  const errorCountRef = yield* Ref.make(0);

  // Process books directly from the stream without converting to arrays
  yield* egwClient.getBooks({ lang: languageCode }).pipe(
    // Filter to only EGW books (by author name)
    // This ensures we only sync books written by Ellen G. White, not other authors
    Stream.filter((book) => book.author === egwAuthorName),
    Stream.tap(() => Ref.update(totalBooksRef, (n) => n + 1)),
    Stream.mapEffect(
      (book) =>
        Effect.gen(function* () {
          const totalBooksForLog = yield* Ref.get(totalBooksRef);
          yield* Effect.log(
            `Processing book ${totalBooksForLog}: ${book.title} (ID: ${book.book_id})`,
          );

          // Get table of contents to iterate through chapters
          const toc = yield* egwClient.getBookToc(book.book_id);
          if (toc.length === 0) {
            yield* Effect.log(`Skipping book ${book.title}: No chapters found`);
            return;
          }

          // Filter valid TOC items and process as stream
          yield* Stream.fromIterable(toc).pipe(
            Stream.filter((item) => {
              return (
                (item.para_id !== undefined && item.para_id !== null) ||
                (item.puborder !== undefined && item.puborder !== null)
              );
            }),
            Stream.flatMap((tocItem) => {
              let chapterId: string;
              if (tocItem.para_id) {
                const match = tocItem.para_id.match(/^(\d+)\./);
                if (match && match[1]) {
                  chapterId = match[1];
                } else {
                  chapterId = String(tocItem.puborder);
                }
              } else {
                chapterId = String(tocItem.puborder);
              }

              return Stream.fromEffect(
                egwClient.getChapterContent(book.book_id, chapterId),
              );
            }),
            Stream.flatMap((paragraphs) => Stream.fromIterable(paragraphs)),
            Stream.mapEffect(
              (paragraph) =>
                Effect.gen(function* () {
                  yield* paragraphDb.storeParagraph(paragraph, book).pipe(
                    Effect.tap(() =>
                      Effect.gen(function* () {
                        yield* Ref.update(storedParagraphsRef, (n) => n + 1);
                        const count = yield* Ref.get(storedParagraphsRef);
                        if (count % 100 === 0) {
                          yield* Effect.log(`Stored ${count} paragraphs...`);
                        }
                      }),
                    ),
                    Effect.catchAll((error) =>
                      Effect.gen(function* () {
                        yield* Ref.update(errorCountRef, (n) => n + 1);
                        yield* Effect.logError(
                          `Failed to store paragraph:`,
                          error,
                        );
                        return yield* Effect.void;
                      }),
                    ),
                  );
                }),
              { concurrency: 100 }, // Store multiple paragraphs concurrently
            ),
            Stream.runDrain,
          );

          yield* Ref.update(booksProcessedRef, (n) => n + 1);
          const completedCount = yield* Ref.get(booksProcessedRef);
          const totalCount = yield* Ref.get(totalBooksRef);
          yield* Effect.log(
            `Completed book ${completedCount}/${totalCount}: ${book.title}`,
          );
        }),
      { concurrency: 1 }, // Process one book at a time to avoid overwhelming the API
    ),
    Stream.runDrain,
  );

  // Get final statistics from Refs
  const totalBooks = yield* Ref.get(totalBooksRef);
  const booksProcessed = yield* Ref.get(booksProcessedRef);
  const storedParagraphs = yield* Ref.get(storedParagraphsRef);
  const errorCount = yield* Ref.get(errorCountRef);

  yield* Effect.log(
    `Sync complete! Processed ${booksProcessed} books, stored ${storedParagraphs} paragraphs, ${errorCount} errors.`,
  );

  if (totalBooks === 0) {
    yield* Effect.logError(
      `No EGW books found for author "${egwAuthorName}". Please verify the author name is correct.`,
    );
  }

  return {
    totalBooks,
    booksProcessed,
    storedParagraphs,
    errorCount,
  };
});

// Compose all layers
const ServiceLayer = Layer.mergeAll(
  EGWParagraphDatabase.Default, // Scoped service - gets FileSystem/Path from BunContext
  Layer.provide(EGWApiClient.Default, FetchHttpClient.layer),
);

const AppLayer = ServiceLayer.pipe(Layer.provide(BunContext.layer));

// Run the program with all required dependencies
BunRuntime.runMain(program.pipe(Effect.provide(AppLayer)));
