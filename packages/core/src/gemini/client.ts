/**
 * Gemini File Search API Client using Effect-TS
 * Based on https://www.philschmid.de/gemini-file-search-javascript
 * Adapted from Spotify client patterns with Effect-TS
 */

import {
  Chunk,
  Config,
  Data,
  Duration,
  Effect,
  Option,
  Redacted,
  Schedule,
  Stream,
} from "effect";
import { GoogleGenAI } from "@google/genai";
import type {
  Pager,
  FileSearchStore,
  Document,
  UploadToFileSearchStoreOperation,
  CustomMetadata,
} from "@google/genai";
import * as Schemas from "./schemas.js";

// Type aliases for API types
type FileSearchStorePager = Pager<FileSearchStore>;
type DocumentPager = Pager<Document>;
type UploadOperation = UploadToFileSearchStoreOperation;

/**
 * Gemini File Search Client Errors
 */
export class GeminiFileSearchError extends Data.TaggedError(
  "GeminiFileSearchError"
)<{
  readonly cause: unknown;
  readonly message: string;
}> {}

/**
 * Gemini File Search Client Service
 */
export class GeminiFileSearchClient extends Effect.Service<GeminiFileSearchClient>()(
  "lib/Gemini/Client",
  {
    effect: Effect.gen(function* () {
      const apiKey = yield* Config.redacted("GOOGLE_AI_API_KEY").pipe(
        Config.withDefault(
          process.env.GOOGLE_AI_API_KEY
            ? Redacted.make(process.env.GOOGLE_AI_API_KEY)
            : Redacted.make("")
        )
      );

      const ai = new GoogleGenAI({
        apiKey: Redacted.value(apiKey),
      });

      /**
       * Retry schedule with exponential backoff
       * Maximum 3 retries (1 initial attempt + 2 retries)
       * Exponential delays: 100ms, 200ms, 400ms
       */
      const retrySchedule = Schedule.exponential(Duration.millis(100)).pipe(
        Schedule.compose(Schedule.recurs(2))
      );

      const pollOperation = (
        operation: UploadOperation,
        pollIntervalMs: number = 1000
      ): Effect.Effect<Schemas.Operation, GeminiFileSearchError> =>
        Effect.gen(function* () {
          if (operation.done) {
            return {
              name: operation.name || "",
              done: true,
              error:
                operation.error &&
                typeof operation.error === "object" &&
                "code" in operation.error &&
                "message" in operation.error
                  ? {
                      code:
                        typeof operation.error.code === "number"
                          ? operation.error.code
                          : 0,
                      message:
                        typeof operation.error.message === "string"
                          ? operation.error.message
                          : "Unknown error",
                    }
                  : undefined,
              response: operation.response,
            } as Schemas.Operation;
          }

          yield* Effect.sleep(Duration.millis(pollIntervalMs));
          const updatedOperation = yield* Effect.tryPromise({
            try: () => ai.operations.get({ operation }),
            catch: (error) =>
              new GeminiFileSearchError({
                message: "Failed to get operation status",
                cause: error,
              }),
          }).pipe(Effect.retry(retrySchedule));
          return yield* pollOperation(
            updatedOperation as UploadOperation,
            pollIntervalMs
          );
        });

      const searchStoresRecursive = (
        pager: FileSearchStorePager,
        displayName: string
      ): Effect.Effect<Schemas.FileSearchStore | null, GeminiFileSearchError> =>
        Effect.gen(function* () {
          const page = pager.page || [];

          // Search current page
          for (const store of page) {
            if (store.displayName === displayName) {
              return {
                name: store.name || "",
                displayName: store.displayName || "",
              } as Schemas.FileSearchStore;
            }
          }

          // Check next page
          if (!pager.hasNextPage()) {
            return null;
          }

          const nextPager = yield* Effect.tryPromise({
            try: () => pager.nextPage(),
            catch: (error) =>
              new GeminiFileSearchError({
                message: "Failed to get next page of stores",
                cause: error,
              }),
          }).pipe(Effect.retry(retrySchedule));

          return yield* searchStoresRecursive(
            nextPager as unknown as FileSearchStorePager,
            displayName
          );
        });

      const searchDocumentsRecursive = (
        pager: DocumentPager,
        displayName: string
      ): Effect.Effect<Schemas.Document | null, GeminiFileSearchError> =>
        Effect.gen(function* () {
          const page = pager.page || [];

          // Search current page
          for (const doc of page) {
            if (doc.displayName === displayName) {
              return {
                name: doc.name || "",
                displayName: doc.displayName || "",
                createTime: doc.createTime,
                updateTime: doc.updateTime,
              } as Schemas.Document;
            }
          }

          // Check next page
          if (!pager.hasNextPage()) {
            return null;
          }

          const nextPager = yield* Effect.tryPromise({
            try: () => pager.nextPage(),
            catch: (error) =>
              new GeminiFileSearchError({
                message: "Failed to get next page of documents",
                cause: error,
              }),
          }).pipe(Effect.retry(retrySchedule));

          return yield* searchDocumentsRecursive(
            nextPager as unknown as DocumentPager,
            displayName
          );
        });

      return {
        createStore: (displayName: string) =>
          Effect.gen(function* () {
            const store = yield* Effect.tryPromise({
              try: () =>
                ai.fileSearchStores.create({
                  config: { displayName },
                }),
              catch: (error) =>
                new GeminiFileSearchError({
                  message: `Failed to create file search store: ${displayName}`,
                  cause: error,
                }),
            });
            return {
              name: store.name || "",
              displayName: store.displayName || displayName,
            } as Schemas.FileSearchStore;
          }).pipe(Effect.retry(retrySchedule)),

        findStoreByDisplayName: (displayName: string, pageSize: number = 10) =>
          Effect.gen(function* () {
            const pager = yield* Effect.tryPromise({
              try: () => ai.fileSearchStores.list({ config: { pageSize } }),
              catch: (error) =>
                new GeminiFileSearchError({
                  message: "Failed to list file search stores",
                  cause: error,
                }),
            });
            const store = yield* searchStoresRecursive(pager, displayName);
            if (!store) {
              return yield* Effect.fail(
                new GeminiFileSearchError({
                  message: `Store with display name '${displayName}' not found`,
                  cause: undefined,
                })
              );
            }
            return store;
          }).pipe(Effect.retry(retrySchedule)),

        uploadFile: (
          filePath: string,
          fileSearchStoreName: string,
          config: Schemas.UploadConfig
        ) =>
          Effect.gen(function* () {
            // Convert metadata to API format using the helper
            // The helper handles conversion from SimpleMetadata or CustomMetadata[]
            // and ensures all values are in the correct format for the API
            const apiMetadata = Schemas.toCustomMetadata(config.customMetadata);

            const operation = yield* Effect.tryPromise({
              try: () =>
                ai.fileSearchStores.uploadToFileSearchStore({
                  file: filePath,
                  fileSearchStoreName,
                  config: {
                    displayName: config.displayName,
                    // API expects CustomMetadata[] format
                    customMetadata: apiMetadata as CustomMetadata[],
                    chunkingConfig: config.chunkingConfig,
                  },
                }),
              catch: (error) =>
                new GeminiFileSearchError({
                  message: `Failed to upload file: ${filePath}`,
                  cause: error,
                }),
            });
            return yield* pollOperation(operation);
          }).pipe(Effect.retry(retrySchedule)),

        uploadContent: (
          content: string | Uint8Array | Buffer,
          fileSearchStoreName: string,
          config: Schemas.UploadConfig
        ) =>
          Effect.gen(function* () {
            // Convert metadata to API format using the helper
            const apiMetadata = Schemas.toCustomMetadata(config.customMetadata);

            // Convert content to a File object (Bun supports File API)
            // Handle different content types properly for File constructor
            // Type assertion needed due to strict TypeScript types, but runtime works correctly
            const fileParts =
              typeof content === "string"
                ? [content]
                : Buffer.isBuffer(content)
                  ? [
                      new Uint8Array(
                        content.buffer,
                        content.byteOffset,
                        content.byteLength
                      ) as BlobPart,
                    ]
                  : [content as BlobPart];

            const file = new File(
              fileParts as BlobPart[],
              config.displayName || "document.txt",
              {
                type: "text/plain",
              }
            );

            const contentLength =
              typeof content === "string"
                ? content.length
                : content.byteLength || content.length;

            yield* Effect.log(
              `Uploading content (${contentLength} bytes) to store: ${fileSearchStoreName} with displayName: ${config.displayName}`
            );

            const operation = yield* Effect.tryPromise({
              try: () =>
                ai.fileSearchStores.uploadToFileSearchStore({
                  file: file,
                  fileSearchStoreName,
                  config: {
                    displayName: config.displayName,
                    // API expects CustomMetadata[] format
                    customMetadata: apiMetadata as CustomMetadata[],
                    chunkingConfig: config.chunkingConfig,
                  },
                }),
              catch: (error) =>
                new GeminiFileSearchError({
                  message: `Failed to upload content to store: ${fileSearchStoreName}`,
                  cause: error,
                }),
            });
            return yield* pollOperation(operation);
          }).pipe(Effect.retry(retrySchedule)),

        uploadFiles: (
          filePaths: string[],
          fileSearchStoreName: string,
          getConfig: (filePath: string) => Schemas.UploadConfig
        ) =>
          Effect.gen(function* () {
            const { uploadFile } = yield* GeminiFileSearchClient;
            // Convert array to stream and process with concurrency
            return yield* Stream.fromIterable(filePaths).pipe(
              Stream.flatMap((filePath) =>
                Stream.fromEffect(
                  uploadFile(filePath, fileSearchStoreName, getConfig(filePath))
                )
              ),
              Stream.runCollect
            );
          }),

        generateContent: (
          model: string,
          contents: string,
          fileSearchStoreNames: string[],
          metadataFilter?: string
        ) =>
          Effect.gen(function* () {
            const response = yield* Effect.tryPromise({
              try: () =>
                ai.models.generateContent({
                  model,
                  contents,
                  config: {
                    tools: [
                      {
                        fileSearch: {
                          fileSearchStoreNames,
                          ...(metadataFilter && { metadataFilter }),
                        },
                      },
                    ],
                  },
                }),
              catch: (error) =>
                new GeminiFileSearchError({
                  message: "Failed to generate content",
                  cause: error,
                }),
            });
            return {
              candidates: (response.candidates || []).map((candidate: any) => ({
                content: {
                  parts: candidate.content.parts.map((part: any) => ({
                    text: part.text,
                  })),
                },
                groundingMetadata: candidate.groundingMetadata
                  ? {
                      searchEntryPoint:
                        candidate.groundingMetadata.searchEntryPoint,
                      retrievalMetadata: candidate.groundingMetadata
                        .retrievalMetadata
                        ? {
                            score:
                              candidate.groundingMetadata.retrievalMetadata
                                .score,
                            chunk:
                              candidate.groundingMetadata.retrievalMetadata
                                .chunk,
                          }
                        : undefined,
                    }
                  : undefined,
              })),
            };
          }).pipe(Effect.retry(retrySchedule)),

        listDocuments: (fileSearchStoreName: string, pageSize: number = 20) =>
          Effect.gen(function* () {
            // Use Stream.unfoldEffect to handle pagination with pager API
            const stream = Stream.unfoldEffect(
              undefined as DocumentPager | undefined,
              (currentPager) =>
                Effect.gen(function* () {
                  // Get the first page or next page
                  let pager: DocumentPager;
                  if (currentPager) {
                    // nextPage() modifies the pager in place and returns the page array
                    yield* Effect.tryPromise({
                      try: () => currentPager.nextPage(),
                      catch: (error) =>
                        new GeminiFileSearchError({
                          message: `Failed to get next page of documents`,
                          cause: error,
                        }),
                    }).pipe(Effect.retry(retrySchedule));
                    // Use the same pager object (which has been modified in place)
                    pager = currentPager;
                  } else {
                    // Get initial pager
                    const pagerResult = yield* Effect.tryPromise({
                      try: () =>
                        ai.fileSearchStores.documents.list({
                          parent: fileSearchStoreName,
                          config: { pageSize },
                        }),
                      catch: (error) =>
                        new GeminiFileSearchError({
                          message: `Failed to list documents in store: ${fileSearchStoreName}`,
                          cause: error,
                        }),
                    }).pipe(Effect.retry(retrySchedule));
                    pager = pagerResult as unknown as DocumentPager;
                  }

                  const page = pager.page || [];

                  // Transform documents
                  const documents = Chunk.fromIterable(
                    page.map((doc: Document) => ({
                      name: doc.name || "",
                      displayName: doc.displayName || "",
                      customMetadata: (doc.customMetadata ||
                        []) as Schemas.CustomMetadata[],
                    }))
                  );

                  // Return documents and next pager (or none if done)
                  // Check if there's a next page by checking if hasNextPage method exists and works
                  // or by checking params directly (which is what hasNextPage does internally)
                  let hasNext = false;
                  if (typeof (pager as any).hasNextPage === "function") {
                    try {
                      hasNext = (pager as any).hasNextPage();
                    } catch {
                      // If hasNextPage throws, check params directly
                      const params = (pager as any).params;
                      hasNext = params?.config?.pageToken !== undefined;
                    }
                  } else {
                    // Fallback: check params directly
                    const params = (pager as any).params;
                    hasNext = params?.config?.pageToken !== undefined;
                  }

                  return Option.some([
                    documents,
                    hasNext ? pager : undefined,
                  ] as const);
                })
            ).pipe(
              Stream.flatMap((documentsChunk) =>
                Stream.fromChunk(documentsChunk)
              )
            );

            // Collect all documents from the stream
            return yield* Stream.runCollect(stream);
          }),

        findDocumentByDisplayName: (
          fileSearchStoreName: string,
          displayName: string
        ) =>
          Effect.gen(function* () {
            const pager = yield* Effect.tryPromise({
              try: () =>
                ai.fileSearchStores.documents.list({
                  parent: fileSearchStoreName,
                }),
              catch: (error) =>
                new GeminiFileSearchError({
                  message: `Failed to list documents in store: ${fileSearchStoreName}`,
                  cause: error,
                }),
            });
            const document = yield* searchDocumentsRecursive(
              pager,
              displayName
            );
            if (!document) {
              return yield* Effect.fail(
                new GeminiFileSearchError({
                  message: `Document '${displayName}' not found in store`,
                  cause: undefined,
                })
              );
            }
            return document;
          }).pipe(Effect.retry(retrySchedule)),

        documentExists: (fileSearchStoreName: string, displayName: string) =>
          Effect.gen(function* () {
            const pager = yield* Effect.tryPromise({
              try: () =>
                ai.fileSearchStores.documents.list({
                  parent: fileSearchStoreName,
                }),
              catch: (error) =>
                new GeminiFileSearchError({
                  message: `Failed to list documents in store: ${fileSearchStoreName}`,
                  cause: error,
                }),
            });
            const document = yield* searchDocumentsRecursive(
              pager,
              displayName
            );
            return document !== null;
          }).pipe(Effect.retry(retrySchedule)),

        countDocumentsByBookId: (fileSearchStoreName: string, bookId: number) =>
          Effect.gen(function* () {
            const { listDocuments } = yield* GeminiFileSearchClient;
            const allDocumentsChunk = yield* listDocuments(fileSearchStoreName);
            // Convert Chunk to Stream and filter documents
            const count = yield* Stream.fromChunk(allDocumentsChunk).pipe(
              Stream.filter((doc) => {
                const bookIdMetadata = doc.customMetadata?.find(
                  (meta: Schemas.CustomMetadata) => meta.key === "book_id"
                );
                return (
                  bookIdMetadata?.stringValue !== undefined &&
                  bookIdMetadata.stringValue === String(bookId)
                );
              }),
              Stream.runCount
            );
            return count;
          }),

        deleteDocument: (documentName: string, force: boolean = true) =>
          Effect.gen(function* () {
            yield* Effect.tryPromise({
              try: () =>
                ai.fileSearchStores.documents.delete({
                  name: documentName,
                  config: { force },
                }),
              catch: (error) =>
                new GeminiFileSearchError({
                  message: `Failed to delete document: ${documentName}`,
                  cause: error,
                }),
            });
          }).pipe(Effect.retry(retrySchedule)),

        updateDocument: (
          filePath: string,
          fileSearchStoreName: string,
          displayName: string,
          config?: Omit<Schemas.UploadConfig, "displayName">
        ) =>
          Effect.gen(function* () {
            const { findDocumentByDisplayName, deleteDocument, uploadFile } =
              yield* GeminiFileSearchClient;
            yield* findDocumentByDisplayName(
              fileSearchStoreName,
              displayName
            ).pipe(
              Effect.flatMap((existingDoc) =>
                deleteDocument(existingDoc.name, true)
              ),
              Effect.catchTag("GeminiFileSearchError", (error) => {
                if (error.message.includes("not found")) {
                  return Effect.void;
                }
                return Effect.fail(error);
              })
            );
            return yield* uploadFile(filePath, fileSearchStoreName, {
              displayName,
              ...config,
            });
          }),

        deleteStore: (storeName: string, force: boolean = true) =>
          Effect.gen(function* () {
            yield* Effect.tryPromise({
              try: () =>
                ai.fileSearchStores.delete({
                  name: storeName,
                  config: { force },
                }),
              catch: (error) =>
                new GeminiFileSearchError({
                  message: `Failed to delete store: ${storeName}`,
                  cause: error,
                }),
            });
          }).pipe(Effect.retry(retrySchedule)),
      } as const;
    }),
  }
) {}
