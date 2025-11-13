/**
 * List EGW Folders Script
 *
 * This script lists all folders available in the EGW API for a given language.
 * Use this to find the folder ID for filtering books (e.g., published writings).
 *
 * Usage:
 *   bun run list-egw-folders.ts [languageCode]
 *
 * Environment Variables Required:
 *   - EGW_CLIENT_ID: EGW API client ID
 *   - EGW_CLIENT_SECRET: EGW API client secret
 *   - EGW_AUTH_BASE_URL: (optional) Defaults to https://cpanel.egwwritings.org
 *   - EGW_API_BASE_URL: (optional) Defaults to https://a.egwwritings.org
 *   - EGW_SCOPE: (optional) Defaults to "writings search studycenter subscriptions user_info"
 */

import { FetchHttpClient } from '@effect/platform';
import { BunContext, BunRuntime } from '@effect/platform-bun';
import { Effect, Layer } from 'effect';

import { EGWApiClient } from '../src/egw/client.js';
import * as EGWSchemas from '../src/egw/schemas.js';

const languageCode = process.argv[2] || 'en';

const program = Effect.gen(function* () {
  const egwClient = yield* EGWApiClient;

  yield* Effect.log(`Fetching folders for language: ${languageCode}...`);

  const folders = yield* egwClient.getFoldersByLanguage(languageCode);

  // Recursive function to display folder hierarchy
  const displayFolders = (
    folders: ReadonlyArray<EGWSchemas.Folder>,
    indent = '',
  ): Effect.Effect<void> =>
    Effect.gen(function* () {
      for (const folder of folders) {
        yield* Effect.log(
          `${indent}📁 ${folder.name} (ID: ${folder.folder_id}) - ${folder.nbooks} books, ${folder.naudiobooks} audiobooks`,
        );
        if (folder.children && folder.children.length > 0) {
          yield* displayFolders(folder.children, indent + '  ');
        }
      }
    });

  yield* Effect.log(`\nFound ${folders.length} top-level folders:\n`);
  yield* displayFolders(folders);

  yield* Effect.log(`\n✅ Folder listing complete!`);
  yield* Effect.log(
    `💡 Tip: Use the folder ID in upload-egw.ts or sync-egw-books.ts to filter books by folder.`,
  );

  return folders;
});

// Compose all layers
const ServiceLayer = Layer.provide(EGWApiClient.Default, FetchHttpClient.layer);

const AppLayer = ServiceLayer.pipe(Layer.provide(BunContext.layer));

// Run the program with all required dependencies
BunRuntime.runMain(program.pipe(Effect.provide(AppLayer)));
