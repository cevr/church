/**
 * Gemini File Search API - Main Export
 *
 * This module provides a complete Effect-TS integration for the Gemini File Search API.
 * Adapted from Spotify client patterns with Effect-TS.
 *
 * @example
 * ```ts
 * import { GeminiFileSearchClient } from "~/lib/gemini";
 * import { Effect, Layer } from "effect";
 *
 * const program = Effect.gen(function* () {
 *   const client = yield* GeminiFileSearchClient;
 *   const store = yield* client.createStore("my-store");
 *   return yield* client.generateContent(
 *     "gemini-2.5-flash",
 *     "What is Gemini?",
 *     [store.name]
 *   );
 * });
 *
 * Effect.runPromise(program.pipe(Layer.provide(GeminiFileSearchClient.Default))).then(console.log);
 * ```
 */

export { GeminiFileSearchClient, GeminiFileSearchError } from './client.js';

export * as Schemas from './schemas.js';
