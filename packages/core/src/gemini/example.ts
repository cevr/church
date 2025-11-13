/**
 * Example usage of Gemini File Search Client with Effect-TS
 * Based on the tutorial: https://www.philschmid.de/gemini-file-search-javascript
 */

import { Path } from '@effect/platform';
import { Effect } from 'effect';

import { GeminiFileSearchClient } from './client.js';
import * as Schemas from './schemas.js';

/**
 * Example 1: Create a File Search Store
 */
export const createStoreExample = (displayName: string) =>
  Effect.gen(function* () {
    const client = yield* GeminiFileSearchClient;
    const store = yield* client.createStore(displayName);
    yield* Effect.log(`Store created: ${store.name}`);
    return store;
  }).pipe(
    Effect.catchAll((error) =>
      Effect.logError('Failed to create store:', error),
    ),
    Effect.provide(GeminiFileSearchClient.Default),
  );

/**
 * Example 2: Find a Store by Display Name
 */
export const findStoreExample = (displayName: string) =>
  Effect.gen(function* () {
    const client = yield* GeminiFileSearchClient;
    const store = yield* client.findStoreByDisplayName(displayName);
    yield* Effect.log(`Found store: ${store.name}`);
    return store;
  }).pipe(
    Effect.catchAll((error) => Effect.logError('Failed to find store:', error)),
    Effect.provide(GeminiFileSearchClient.Default),
  );

/**
 * Example 3: Upload Multiple Files Concurrently
 */
export const uploadFilesExample = (
  fileSearchStoreName: string,
  docsDir: string,
  files: string[],
) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const filePaths = files.map((file) => path.join(docsDir, file));
    const client = yield* GeminiFileSearchClient;
    const operations = yield* client.uploadFiles(
      filePaths,
      fileSearchStoreName,
      (filePath) => ({
        displayName: path.basename(filePath),
      }),
    );
    yield* Effect.log(`Processing complete for ${operations.length} files`);
    return operations;
  }).pipe(
    Effect.catchAll((error) =>
      Effect.logError('Failed to upload files:', error),
    ),
    Effect.provide(GeminiFileSearchClient.Default),
    Effect.provide(Path.layer),
  );

/**
 * Example 4: Advanced Upload with Custom Chunking
 */
export const advancedUploadExample = (
  fileSearchStoreName: string,
  filePath: string,
) => {
  const config: Schemas.UploadConfig = {
    displayName: 'technical-manual.txt',
    customMetadata: [{ key: 'doc_type', stringValue: 'manual' }],
    chunkingConfig: {
      whiteSpaceConfig: {
        maxTokensPerChunk: 500,
        maxOverlapTokens: 50,
      },
    },
  };

  return Effect.gen(function* () {
    const client = yield* GeminiFileSearchClient;
    const operation = yield* client.uploadFile(
      filePath,
      fileSearchStoreName,
      config,
    );
    yield* Effect.log('Advanced file processed');
    return operation;
  }).pipe(
    Effect.catchAll((error) =>
      Effect.logError('Failed to upload file:', error),
    ),
    Effect.provide(GeminiFileSearchClient.Default),
  );
};

/**
 * Example 5: Run a Generation Query using File Search (RAG)
 */
export const generateContentExample = (
  fileSearchStoreName: string,
  query: string,
) =>
  Effect.gen(function* () {
    const client = yield* GeminiFileSearchClient;
    const response = yield* client.generateContent('gemini-2.5-flash', query, [
      fileSearchStoreName,
    ]);
    const text =
      response.candidates[0]?.content.parts[0]?.text || 'No response';
    yield* Effect.log('Model response:', text);
    // Optionally check groundingMetadata for citations
    const metadata = response.candidates[0]?.groundingMetadata;
    if (metadata) {
      yield* Effect.log('Grounding metadata:', metadata);
    }
    return response;
  }).pipe(
    Effect.catchAll((error) =>
      Effect.logError('Failed to generate content:', error),
    ),
    Effect.provide(GeminiFileSearchClient.Default),
  );

/**
 * Example 6: Generate Content with Metadata Filter
 */
export const generateContentWithFilterExample = (
  fileSearchStoreName: string,
  query: string,
) =>
  Effect.gen(function* () {
    const client = yield* GeminiFileSearchClient;
    const response = yield* client.generateContent(
      'gemini-2.5-flash',
      query,
      [fileSearchStoreName],
      'doc_type="manual"',
    );
    const text =
      response.candidates[0]?.content.parts[0]?.text || 'No response';
    yield* Effect.log('Filtered response:', text);
    return response;
  }).pipe(
    Effect.catchAll((error) =>
      Effect.logError('Failed to generate content:', error),
    ),
    Effect.provide(GeminiFileSearchClient.Default),
  );

/**
 * Example 7: Find a Specific Document
 */
export const findDocumentExample = (
  fileSearchStoreName: string,
  displayName: string,
) =>
  Effect.gen(function* () {
    const client = yield* GeminiFileSearchClient;
    const document = yield* client.findDocumentByDisplayName(
      fileSearchStoreName,
      displayName,
    );
    yield* Effect.log(`Found document: ${document.name}`);
    return document;
  }).pipe(
    Effect.catchAll((error) =>
      Effect.logError('Failed to find document:', error),
    ),
    Effect.provide(GeminiFileSearchClient.Default),
  );

/**
 * Example 8: Delete a Document
 */
export const deleteDocumentExample = (documentName: string) =>
  Effect.gen(function* () {
    const client = yield* GeminiFileSearchClient;
    yield* client.deleteDocument(documentName, true);
    yield* Effect.log('Document deleted successfully');
  }).pipe(
    Effect.catchAll((error) =>
      Effect.logError('Failed to delete document:', error),
    ),
    Effect.provide(GeminiFileSearchClient.Default),
  );

/**
 * Example 9: Update a Document
 */
export const updateDocumentExample = (
  fileSearchStoreName: string,
  filePath: string,
  displayName: string,
) =>
  Effect.gen(function* () {
    const client = yield* GeminiFileSearchClient;
    const operation = yield* client.updateDocument(
      filePath,
      fileSearchStoreName,
      displayName,
    );
    yield* Effect.log('Document updated successfully');
    return operation;
  }).pipe(
    Effect.catchAll((error) =>
      Effect.logError('Failed to update document:', error),
    ),
    Effect.provide(GeminiFileSearchClient.Default),
  );

/**
 * Example 10: Delete a File Search Store
 */
export const deleteStoreExample = (storeName: string) =>
  Effect.gen(function* () {
    const client = yield* GeminiFileSearchClient;
    yield* client.deleteStore(storeName, true);
    yield* Effect.log('Store deleted successfully');
  }).pipe(
    Effect.catchAll((error) =>
      Effect.logError('Failed to delete store:', error),
    ),
    Effect.provide(GeminiFileSearchClient.Default),
  );

/**
 * Complete workflow example
 */
export const completeWorkflowExample = Effect.gen(function* () {
  const client = yield* GeminiFileSearchClient;
  const storeName = 'my-example-store';

  // 1. Create or find store
  const store = yield* client
    .findStoreByDisplayName(storeName)
    .pipe(Effect.catchAll(() => client.createStore(storeName)));

  yield* Effect.log(`Using store: ${store.name}`);

  // 2. Upload files (example)
  // const uploadResult = yield* uploadFilesExample(store.name, "docs", ["file1.txt", "file2.txt"]);

  // 3. Generate content
  const response = yield* client.generateContent(
    'gemini-2.5-flash',
    'What is Gemini and what is the File API?',
    [store.name],
  );

  yield* Effect.log('Response:', response);

  // 4. Cleanup (optional)
  // yield* client.deleteStore(store.name, true);

  return response;
}).pipe(Effect.provide(GeminiFileSearchClient.Default));
