/**
 * EGW-Gemini Integration - Main Export
 *
 * This module provides a service that combines the EGW API client and Gemini File Search
 * to store EGW books as searchable documents and query them.
 *
 * @example
 * ```ts
 * import { EGWGeminiService } from "~/lib/egw-gemini";
 * import { EGWApiClient, EGWAuth } from "~/lib/egw";
 * import { GeminiFileSearchClient } from "~/lib/gemini";
 * import { FileSystem, Path } from "@effect/platform";
 * import { Effect } from "effect";
 *
 * const program = Effect.gen(function* () {
 *   const service = yield* EGWGeminiService;
 *
 *   // Upload a book (one paragraph per document)
 *   const result = yield* service.uploadBook({
 *     storeDisplayName: "egw-books",
 *     bookId: 123,
 *   });
 *
 *   // Query the store
 *   const queryResult = yield* service.queryStore({
 *     storeDisplayName: "egw-books",
 *     query: "What does the Bible say about prayer?",
 *   });
 *
 *   return queryResult;
 * });
 *
 * Effect.runPromise(
 *   program.pipe(
 *     Effect.provide(EGWGeminiService.Default),
 *     Effect.provide(EGWApiClient.Default),
 *     Effect.provide(EGWAuth.Default),
 *     Effect.provide(GeminiFileSearchClient.Default),
 *     Effect.provide(Path.layer),
 *     Effect.provide(FileSystem.layer)
 *   )
 * ).then(console.log);
 * ```
 */

export { EGWGeminiService, EGWGeminiError } from './service.js';
export type {
  UploadBookOptions,
  QueryOptions,
  UploadAllEGWWritingsOptions,
} from './service.js';

export {
  EGWUploadStatus,
  DatabaseConnectionError,
  DatabaseQueryError,
  ParagraphUploadNotFoundError,
  SchemaInitializationError,
} from './upload-status.js';
export type {
  BookUploadStatus,
  ParagraphUploadStatus,
  UploadStatusMap,
  UploadStatusError,
} from './upload-status.js';
