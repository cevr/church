/**
 * Query EGW Store Script
 *
 * This script queries a Gemini File Search store containing EGW (Ellen G. White) writings
 * using natural language queries.
 *
 * Usage:
 *   bun run query-egw.ts [query] [options]
 *
 * Examples:
 *   bun run query-egw.ts "What does the Bible say about prayer?"
 *   bun run query-egw.ts "What is the Sabbath?" --store egw-writings
 *   bun run query-egw.ts "Tell me about salvation" --metadata-filter 'book_title="The Desire of Ages"'
 *
 * Environment Variables Required:
 *   - GOOGLE_AI_API_KEY: Your Google AI API key
 *   - EGW_CLIENT_ID: EGW API client ID (optional, only needed if querying requires auth)
 *   - EGW_CLIENT_SECRET: EGW API client secret (optional, only needed if querying requires auth)
 */

import { Args, Command } from '@effect/cli';
import { text } from '@effect/cli/Prompt';
import { FetchHttpClient } from '@effect/platform';
import {
  BunContext,
  BunFileSystem,
  BunPath,
  BunRuntime,
} from '@effect/platform-bun';
import { Effect, Layer, Option } from 'effect';

import { EGWGeminiService } from '../src/egw-gemini/index.js';
import { GeminiFileSearchClient } from '../src/gemini/index.js';

const queryArg = Args.text({
  name: 'query',
}).pipe(Args.optional);

const storeOption = Args.text({
  name: 'store',
}).pipe(
  Args.withDefault('egw-writings'),
  Args.withDescription('The display name of the Gemini File Search store'),
);

const metadataFilterOption = Args.text({
  name: 'metadata-filter',
}).pipe(
  Args.optional,
  Args.withDescription(
    'Optional metadata filter to narrow search results (e.g., book_title="The Desire of Ages")',
  ),
);

const cli = Command.make(
  'query-egw',
  {
    query: queryArg,
    store: storeOption,
    metadataFilter: metadataFilterOption,
  },
  (args: {
    query: Option.Option<string>;
    store: string;
    metadataFilter: Option.Option<string>;
  }) =>
    Effect.gen(function* () {
      const service = yield* EGWGeminiService;

      // Get query from args or prompt user
      const query = yield* Option.match(args.query, {
        onSome: (q) => Effect.succeed(q),
        onNone: () =>
          text({
            message: 'What would you like to query from the EGW store?',
          }),
      });

      yield* Effect.log(`Querying store: ${args.store}`);
      yield* Effect.log(`Query: ${query}`);

      const metadataFilter = yield* Option.match(args.metadataFilter, {
        onSome: (f) => Effect.succeed(f),
        onNone: () => Effect.succeed(undefined),
      });

      if (metadataFilter) {
        yield* Effect.log(`Metadata filter: ${metadataFilter}`);
      }

      // Query the store
      const result = yield* service.queryStore({
        storeDisplayName: args.store,
        query,
        metadataFilter,
      });

      // Display query information
      yield* Effect.log('\n═══════════════════════════════════════════════════════');
      yield* Effect.log('QUERY RESULTS');
      yield* Effect.log('═══════════════════════════════════════════════════════');
      yield* Effect.log(`Store: ${result.store.displayName} (${result.store.name})`);
      yield* Effect.log(`Query: ${result.query}`);
      yield* Effect.log(`Candidates: ${result.response.candidates?.length || 0}`);
      yield* Effect.log('');

      // Display all candidates
      const candidates = result.response.candidates || [];
      if (candidates.length === 0) {
        yield* Effect.log('⚠️  No candidates found in response');
      } else {
        for (let i = 0; i < candidates.length; i++) {
          const candidate = candidates[i];
          if (!candidate) continue;

          yield* Effect.log(
            `\n${'─'.repeat(55)}\nCANDIDATE ${i + 1} of ${candidates.length}\n${'─'.repeat(55)}`,
          );

          // Display content parts
          if (candidate.content?.parts) {
            yield* Effect.log('\n📝 Content:');
            for (let j = 0; j < candidate.content.parts.length; j++) {
              const part = candidate.content.parts[j];
              if (part?.text) {
                yield* Effect.log(`\nPart ${j + 1}:`);
                yield* Effect.log(part.text);
              } else {
                yield* Effect.log(`\nPart ${j + 1}: (non-text content)`);
              }
            }
          } else {
            yield* Effect.log('\n📝 Content: (no content parts)');
          }

          // Display grounding metadata
          if (candidate.groundingMetadata) {
            yield* Effect.log('\n🔍 Grounding Metadata:');
            const metadata = candidate.groundingMetadata;

            if (metadata.searchEntryPoint) {
              yield* Effect.log(`  Search Entry Point: ${metadata.searchEntryPoint}`);
            }

            if (metadata.retrievalMetadata) {
              yield* Effect.log('  Retrieval Metadata:');
              const retrieval = metadata.retrievalMetadata;

              if (retrieval.score !== undefined) {
                yield* Effect.log(`    Relevance Score: ${retrieval.score}`);
              }

              if (retrieval.chunk) {
                const chunkPreview =
                  retrieval.chunk.length > 300
                    ? `${retrieval.chunk.substring(0, 300)}...`
                    : retrieval.chunk;
                yield* Effect.log(
                  `    Retrieved Chunk (${retrieval.chunk.length} chars):`,
                );
                yield* Effect.log(`    ${chunkPreview.split('\n').join('\n    ')}`);
              }
            } else {
              yield* Effect.log('  (no retrieval metadata)');
            }
          } else {
            yield* Effect.log('\n🔍 Grounding Metadata: (none)');
          }
        }
      }

      // Display any additional response data
      yield* Effect.log(`\n${'═'.repeat(55)}`);
      yield* Effect.log('RESPONSE SUMMARY');
      yield* Effect.log(`${'═'.repeat(55)}`);
      yield* Effect.log(`Total candidates: ${candidates.length}`);
      yield* Effect.log(`Store: ${result.store.displayName}`);
      yield* Effect.log(`${'═'.repeat(55)}\n`);

      return result;
    }),
);

const program = Command.run(cli, {
  name: 'Query EGW Store',
  version: '1.0.0',
});

// Set up service layers
const ServiceLayer = Layer.mergeAll(
  Layer.provideMerge(
    Layer.provide(EGWGeminiService.Default, FetchHttpClient.layer),
    Layer.mergeAll(BunFileSystem.layer, BunPath.layer),
  ),
  GeminiFileSearchClient.Default,
);

// Provide BunContext first for scoped services
const AppLayer = Layer.mergeAll(ServiceLayer, BunContext.layer);

program(process.argv).pipe(Effect.provide(AppLayer), BunRuntime.runMain);
