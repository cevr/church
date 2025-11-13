/**
 * EGW-Gemini Integration Service
 *
 * This service combines the EGW API client and Gemini File Search client
 * to store EGW books as searchable documents and query them.
 */

import { FileSystem } from '@effect/platform';
import { Data, Effect, Option, Ref, Stream } from 'effect';

import { EGWParagraphDatabase } from '../egw-db/index.js';
import type { ParagraphDatabaseError } from '../egw-db/index.js';
import { EGWApiClient, EGWApiError } from '../egw/client.js';
import * as EGWSchemas from '../egw/schemas.js';
import {
  GeminiFileSearchClient,
  GeminiFileSearchError,
} from '../gemini/client.js';
import * as GeminiSchemas from '../gemini/schemas.js';
import { EGWUploadStatus } from './upload-status.js';

/**
 * EGW-Gemini Service Errors
 */
export class EGWGeminiError extends Data.TaggedError('EGWGeminiError')<{
  readonly cause: unknown;
  readonly message: string;
}> {}

/**
 * Upload Book Options
 */
export interface UploadBookOptions {
  readonly storeDisplayName: string;
  readonly book: EGWSchemas.Book;
  readonly toc: readonly EGWSchemas.TocItem[];
  readonly customMetadata?:
    | GeminiSchemas.SimpleMetadata
    | GeminiSchemas.CustomMetadata[];
}

/**
 * Query Options
 */
export interface QueryOptions {
  readonly storeDisplayName: string;
  readonly query: string;
  readonly model?: string;
  readonly metadataFilter?: string;
}

/**
 * Upload All EGW Writings Options
 */
export interface UploadAllEGWWritingsOptions {
  readonly storeDisplayName: string;
  readonly languageCode?: string; // Default: "en"
  readonly egwAuthorName?: string; // Default: "Ellen Gould White"
  readonly folderId?: number; // Optional folder ID to filter books by folder
  readonly customMetadata?: GeminiSchemas.CustomMetadata[];
}

/**
 * EGW-Gemini Integration Service
 */
export class EGWGeminiService extends Effect.Service<EGWGeminiService>()(
  'lib/EGWGemini/Service',
  {
    effect: Effect.gen(function* () {
      const egwClient = yield* EGWApiClient;
      const geminiClient = yield* GeminiFileSearchClient;
      const uploadStatus = yield* EGWUploadStatus;
      const paragraphDb = yield* EGWParagraphDatabase;

      /**
       * Get or create a file search store
       */
      const getOrCreateStore = (
        displayName: string,
      ): Effect.Effect<
        GeminiSchemas.FileSearchStore,
        EGWGeminiError | GeminiFileSearchError
      > =>
        geminiClient.findStoreByDisplayName(displayName).pipe(
          Effect.catchTag('GeminiFileSearchError', (error) => {
            // If store not found, create it
            if (error.message.includes('not found')) {
              return geminiClient.createStore(displayName);
            }
            // Re-throw other errors
            return Effect.fail(error);
          }),
        );

      /**
       * Upload a book, one paragraph per document using streams
       */
      const uploadBook = (options: UploadBookOptions) =>
        Effect.gen(function* () {
          const store = yield* getOrCreateStore(options.storeDisplayName);

          // Get book information from API (paragraph database doesn't store full book info)
          yield* Effect.log(
            `Uploading book: ${options.book.title} (ID: ${options.book.book_id})`,
          );

          // Filter out TOC items without a valid identifier for the chapter endpoint
          // Prefer para_id (paragraph ID) when available, fall back to puborder
          const validTocItems = options.toc.filter((item) => {
            // Must have either para_id or puborder
            return (
              (item.para_id !== undefined && item.para_id !== null) ||
              (item.puborder !== undefined && item.puborder !== null)
            );
          });

          yield* Effect.log(
            `Processing ${validTocItems.length} chapters (${options.toc.length} total TOC items)`,
          );

          // Note: We track upload status at the paragraph level by ref_code
          // Each paragraph will be marked as in-progress when we start uploading it

          // Create a Ref to track the count of uploaded documents (memory efficient)
          const countRef = yield* Ref.make(0);

          // Stream chapters -> paragraphs -> grouped documents -> upload
          yield* Stream.fromIterable(validTocItems).pipe(
            // Get paragraphs for each chapter
            // Prefer para_id (extract chapter number from "chapter.paragraph" format)
            // Fall back to puborder if para_id is not available
            Stream.flatMap((tocItem) => {
              let chapterId: string;
              if (tocItem.para_id) {
                // para_id has pattern ^\d+\.\d+$ (e.g., "1.1", "2.5")
                // Extract the chapter number (part before the dot)
                const match = tocItem.para_id.match(/^(\d+)\./);
                if (match && match[1]) {
                  chapterId = match[1];
                } else {
                  // Fallback to puborder if para_id format is unexpected
                  chapterId = String(tocItem.puborder);
                }
              } else {
                // Use puborder as fallback
                chapterId = String(tocItem.puborder);
              }

              return Stream.fromEffect(
                egwClient.getChapterContent(options.book.book_id, chapterId),
              );
            }),
            // Flatten array of paragraphs into stream of individual paragraphs
            Stream.flatMap((paragraphs) => Stream.fromIterable(paragraphs)),
            // Filter out empty paragraphs before processing
            Stream.filter((paragraph) => {
              const paragraphContent = paragraph.content ?? '';

              return paragraphContent.length > 0;
            }),
            // Zip with index for tracking document number
            Stream.zipWithIndex,
            // Map each paragraph to an upload operation
            Stream.mapEffect(
              ([paragraph, index]) => {
                return Effect.gen(function* () {
                  const fs = yield* FileSystem.FileSystem;

                  // Get ref_code for the paragraph (primary identifier)
                  // If no ref_code, use para_id as fallback, or generate a unique identifier
                  const refcode =
                    paragraph.refcode_short ??
                    paragraph.refcode_long ??
                    paragraph.para_id ??
                    `book-${options.book.book_id}-para-${index + 1}`;

                  // Mark paragraph as in-progress before upload
                  yield* uploadStatus
                    .markParagraphInProgress(
                      options.storeDisplayName,
                      refcode,
                      options.book.book_id,
                    )
                    .pipe(Effect.ignore);

                  // Create content from paragraph
                  // Handle nullable fields: refcode_short, refcode_long, and content
                  const paraRefcode =
                    paragraph.refcode_short ?? paragraph.refcode_long ?? null;
                  const paragraphContent = paragraph.content ?? '';
                  const content = paraRefcode
                    ? `${paraRefcode}\n${paragraphContent}`
                    : paragraphContent;

                  // Prepare metadata using simple key-value format
                  // The client will convert this to the API format automatically
                  const metadata: GeminiSchemas.SimpleMetadata = {
                    book_id: options.book.book_id,
                    book_title: options.book.title,
                    book_code: options.book.code,
                    paragraph_count: 1,
                    paragraph_start_id: paragraph.para_id ?? '',
                    // Add ref codes if available
                    ...(paragraph.refcode_short && {
                      refcode_short: paragraph.refcode_short,
                    }),
                    ...(paragraph.refcode_long && {
                      refcode_long: paragraph.refcode_long,
                    }),
                    // Merge any additional custom metadata
                    ...(options.customMetadata as
                      | GeminiSchemas.SimpleMetadata
                      | undefined),
                  };

                  // Create a temporary file (automatically cleaned up when scope closes)
                  const tempFile = yield* fs.makeTempFileScoped({
                    prefix: refcode,
                    suffix: '.txt',
                  });

                  // Write content to temporary file
                  yield* fs.writeFileString(tempFile, content);

                  // Upload file using the temporary file path
                  yield* geminiClient
                    .uploadFile(tempFile, store.name, {
                      displayName: refcode,
                      customMetadata: metadata,
                    })
                    .pipe(
                      Effect.tap(() =>
                        // Mark paragraph as complete after successful upload
                        uploadStatus
                          .markParagraphComplete(
                            options.storeDisplayName,
                            refcode,
                            options.book.book_id,
                          )
                          .pipe(Effect.ignore),
                      ),
                      Effect.tap(() =>
                        // Increment count for successful upload
                        Ref.update(countRef, (n) => n + 1),
                      ),
                      Effect.catchAll((error) =>
                        Effect.gen(function* () {
                          // Mark paragraph as failed on error
                          yield* uploadStatus
                            .markParagraphFailed(
                              options.storeDisplayName,
                              refcode,
                              options.book.book_id,
                              error instanceof Error
                                ? error.message
                                : String(error),
                            )
                            .pipe(Effect.ignore);
                          return yield* Effect.fail(error);
                        }),
                      ),
                    );
                }).pipe(Effect.scoped);
              },
              { concurrency: 100 }, // Limit concurrency to avoid overwhelming the API
            ),
            // Run the stream (don't collect results - we track count with Ref)
            Stream.runDrain,
          );

          // Get the final count from the Ref
          const documentsUploaded = yield* Ref.get(countRef);

          yield* Effect.log(
            `Successfully uploaded ${documentsUploaded} documents for book: ${options.book.title}`,
          );

          // Book upload status is now aggregated from individual paragraph statuses
          // No need to explicitly mark as complete - it's calculated from paragraph statuses

          return {
            store,
            book: options.book,
            documentsUploaded,
          };
        }).pipe(
          Effect.catchAll((error) =>
            Effect.gen(function* () {
              // Individual paragraph failures are already tracked
              // Book-level status will be aggregated from paragraph statuses

              return yield* Effect.fail(
                new EGWGeminiError({
                  message: `Failed to upload book: ${options.book.book_id}`,
                  cause: error,
                }),
              );
            }),
          ),
        );

      /**
       * Query the store with a user-provided query
       */
      const queryStore = (options: QueryOptions) =>
        Effect.gen(function* () {
          // Find the store
          const store = yield* geminiClient.findStoreByDisplayName(
            options.storeDisplayName,
          );
          if (!store) {
            return yield* Effect.fail(
              new EGWGeminiError({
                message: `Store not found: ${options.storeDisplayName}`,
                cause: undefined,
              }),
            );
          }

          // Generate content using the store
          const model = options.model || 'gemini-2.5-flash';
          const response = yield* geminiClient.generateContent(
            model,
            options.query,
            [store.name],
            options.metadataFilter,
          );

          return {
            query: options.query,
            response,
            store,
          };
        }).pipe(
          Effect.catchAll((error) =>
            Effect.fail(
              new EGWGeminiError({
                message: `Failed to query store: ${options.storeDisplayName}`,
                cause: error,
              }),
            ),
          ),
        );

      /**
       * Upload all EGW writings, skipping books that are already uploaded
       * Uses filesystem status tracking to determine upload status
       */
      const uploadAllEGWWritings = (options: UploadAllEGWWritingsOptions) =>
        Effect.gen(function* () {
          // Get or create store
          const store = yield* getOrCreateStore(options.storeDisplayName);
          const egwAuthorName = options.egwAuthorName || 'Ellen Gould White';

          yield* Effect.log(
            `Starting bulk upload of EGW writings to store: ${store.displayName}`,
          );

          const languageCode = options.languageCode || 'en';
          // Track total books found for the return value (count as we process)
          const totalBooksFoundRef = yield* Ref.make(0);

          // If folderId is provided, get books directly from API filtered by folder and author
          // Otherwise, get books from database
          let booksStream: Stream.Stream<
            number,
            EGWApiError | ParagraphDatabaseError
          >;

          if (options.folderId !== undefined) {
            yield* Effect.log(
              `Fetching books from API filtered by folder ${options.folderId} and author ${egwAuthorName}`,
            );

            // Get books from API filtered by folder and author - keep as stream
            booksStream = egwClient
              .getBooks({ lang: languageCode, folder: options.folderId })
              .pipe(
                Stream.filter((book) => book.author === egwAuthorName),
                Stream.map((book) => book.book_id),
              );
          } else {
            // Get books by author from paragraph database
            // The database stores paragraphs, so we get distinct books from paragraphs
            yield* Effect.log(
              `Fetching books by author ${egwAuthorName} from paragraph database`,
            );

            // Create a fresh stream and map to book_id
            booksStream = paragraphDb
              .getBooksByAuthor(egwAuthorName)
              .pipe(Stream.map((book) => book.book_id));
          }

          // Process books in a stream
          const results = yield* booksStream.pipe(
            // Track count as we process
            Stream.tap(() => Ref.update(totalBooksFoundRef, (n) => n + 1)),
            Stream.mapEffect(
              (bookId) =>
                Effect.gen(function* () {
                  const [book, toc] = yield* Effect.all([
                    egwClient.getBook(bookId),
                    egwClient.getBookToc(bookId),
                  ]);
                  if (toc.length === 0) {
                    yield* Effect.log(
                      `Skipping book ${book.title} (ID: ${book.book_id}): No chapters found`,
                    );
                    return Option.none();
                  }

                  // Check upload status (aggregated from paragraph-level tracking)
                  const bookStatus = yield* uploadStatus.getBookUploadStatus(
                    options.storeDisplayName,
                    book.book_id,
                  );

                  // If book is marked as complete, skip it
                  if (
                    Option.isSome(bookStatus) &&
                    bookStatus.value.status === 'complete'
                  ) {
                    yield* Effect.log(
                      `Skipping book ${book.title} (ID: ${book.book_id}): Already uploaded (${bookStatus.value.documentsUploaded}/${bookStatus.value.expectedDocuments} paragraphs, uploaded at ${bookStatus.value.uploadedAt})`,
                    );
                    return Option.none();
                  }

                  // If book previously failed, log and retry
                  if (
                    Option.isSome(bookStatus) &&
                    bookStatus.value.status === 'failed'
                  ) {
                    yield* Effect.log(
                      `Retrying book ${book.title} (ID: ${book.book_id}): Previous upload failed (${bookStatus.value.error || 'unknown error'})`,
                    );
                  }

                  // If book is in-progress, log and continue (will overwrite)
                  if (
                    Option.isSome(bookStatus) &&
                    bookStatus.value.status === 'in-progress'
                  ) {
                    yield* Effect.log(
                      `Resuming book ${book.title} (ID: ${book.book_id}): Previous upload was in-progress`,
                    );
                  }

                  const uploadResult = yield* uploadBook({
                    storeDisplayName: options.storeDisplayName,
                    book,
                    toc,
                    customMetadata: options.customMetadata,
                  });

                  return Option.some(uploadResult);
                }).pipe(
                  Effect.catchAll((error) =>
                    Effect.gen(function* () {
                      yield* Effect.logError(`Failed to process book:`, error);
                      return Option.none();
                    }),
                  ),
                ),
              { concurrency: 1 }, // Process one book at a time to avoid overwhelming APIs
            ),
            Stream.filterMap((result) => result),
            Stream.runCollect,
          );

          // Get the final count of books found
          const totalBooksFound = yield* Ref.get(totalBooksFoundRef);

          yield* Effect.log(
            `Bulk upload complete: ${results.length} books uploaded successfully`,
          );

          return {
            store,
            totalBooksFound,
            booksUploaded: results.length,
            uploadedBooks: results,
          };
        }).pipe(
          Effect.catchAll((error) =>
            Effect.fail(
              new EGWGeminiError({
                message: `Failed to upload all EGW writings`,
                cause: error,
              }),
            ),
          ),
        );

      return {
        uploadBook,
        queryStore,
        getOrCreateStore,
        uploadAllEGWWritings,
      } as const;
    }),
    dependencies: [
      EGWApiClient.Default,
      GeminiFileSearchClient.Default,
      EGWUploadStatus.Default,
      EGWParagraphDatabase.Default,
    ],
  },
) {}
