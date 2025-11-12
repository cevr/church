/**
 * Upload All EGW Writings Script
 *
 * This script uploads all Ellen G. White writings to a Gemini File Search store.
 * It automatically skips books that are already uploaded (95%+ complete).
 *
 * IMPORTANT: Books must be synced to the local database first!
 * Run `bun run sync-egw-books.ts` before running this script.
 *
 * Usage:
 *   bun run upload-egw.ts
 *
 * Prerequisites:
 *   1. Sync books: bun run sync-egw-books.ts [languageCode]
 *
 * Environment Variables Required:
 *   - GOOGLE_AI_API_KEY: Your Google AI API key
 *   - EGW_CLIENT_ID: EGW API client ID
 *   - EGW_CLIENT_SECRET: EGW API client secret
 *   - EGW_AUTH_BASE_URL: (optional) Defaults to https://cpanel.egwwritings.org
 *   - EGW_API_BASE_URL: (optional) Defaults to https://a.egwwritings.org
 *   - EGW_SCOPE: (optional) Defaults to "writings search studycenter subscriptions user_info"
 *   - EGW_BOOK_DB: (optional) Path to book database file, defaults to "data/egw-books.db"
 */

import { EGWGeminiService } from "../src/egw-gemini/index.js";
import { GeminiFileSearchClient } from "../src/gemini/index.js";
import { BunContext, BunRuntime, BunFileSystem, BunPath } from "@effect/platform-bun";
import { FetchHttpClient } from "@effect/platform";
import { Effect, Layer } from "effect";

// Folder ID for "Books" folder (published writings)
// This is under "EGW Writings" (ID: 2) and contains 120 books
const BOOKS_FOLDER_ID = 4;

const program = Effect.gen(function* () {
  const service = yield* EGWGeminiService;

  yield* Effect.log("Starting upload of all EGW writings...");
  yield* Effect.log(
    `Filtering books by folder ID ${BOOKS_FOLDER_ID} (Books - published writings)`
  );

  const languageCode = "en";

  const result = yield* service.uploadAllEGWWritings({
    storeDisplayName: "egw-writings",
    languageCode,
    egwAuthorName: "Ellen Gould White",
    folderId: BOOKS_FOLDER_ID, // Filter by Books folder (published writings)
  });

  yield* Effect.log(
    `Upload complete! Processed ${result.totalBooksFound} books, uploaded ${result.booksUploaded} new books.`
  );

  return result;
});

const ServiceLayer = Layer.mergeAll(
  Layer.provideMerge(
    Layer.provide(EGWGeminiService.Default, FetchHttpClient.layer),
    Layer.mergeAll(BunFileSystem.layer, BunPath.layer)
  ),
  GeminiFileSearchClient.Default
);

// Provide BunContext first for scoped services, then merge with other services
const AppLayer = ServiceLayer.pipe(Layer.provide(BunContext.layer));

const programWithContext = program.pipe(Effect.provide(AppLayer));

BunRuntime.runMain(programWithContext);
