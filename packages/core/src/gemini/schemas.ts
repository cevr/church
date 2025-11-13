/**
 * Gemini File Search API Schemas using Effect Schema
 * Based on the Gemini File Search API documentation
 */

import { Schema } from 'effect';

/**
 * File Search Store Configuration
 */
export const FileSearchStoreConfig = Schema.Struct({
  displayName: Schema.String,
});

export type FileSearchStoreConfig = Schema.Schema.Type<
  typeof FileSearchStoreConfig
>;

/**
 * File Search Store
 */
export const FileSearchStore = Schema.Struct({
  name: Schema.String,
  displayName: Schema.String,
});

export type FileSearchStore = Schema.Schema.Type<typeof FileSearchStore>;

/**
 * Create Store Operation
 */
export const CreateStoreOperation = Schema.Struct({
  name: Schema.String,
  done: Schema.Boolean,
  error: Schema.optional(
    Schema.Struct({
      code: Schema.Number,
      message: Schema.String,
    }),
  ),
});

export type CreateStoreOperation = Schema.Schema.Type<
  typeof CreateStoreOperation
>;

/**
 * Custom Metadata
 * Matches the Gemini API CustomMetadata interface
 */
/**
 * StringList format for the API
 */
export const StringList = Schema.Struct({
  values: Schema.Array(Schema.String),
});

export type StringList = Schema.Schema.Type<typeof StringList>;

export const CustomMetadata = Schema.Struct({
  key: Schema.String,
  stringValue: Schema.optional(Schema.String),
  numericValue: Schema.optional(Schema.Number),
  stringListValue: Schema.optional(StringList),
});

export type CustomMetadata = Schema.Schema.Type<typeof CustomMetadata>;

/**
 * Simple metadata format - accepts string, number, or string array values
 * This is converted to CustomMetadata[] for API calls
 */
export type SimpleMetadata = Record<string, string | number | string[]>;

/**
 * Convert simple key-value metadata to CustomMetadata[] format
 * Handles string, number, and string array values
 *
 * Note: The Gemini API appears to only accept stringValue in practice,
 * so numbers are converted to strings for maximum compatibility.
 */
export function toCustomMetadata(
  metadata: SimpleMetadata | CustomMetadata[] | undefined,
): CustomMetadata[] | undefined {
  if (!metadata) return undefined;

  // If already in CustomMetadata[] format, normalize it
  if (Array.isArray(metadata)) {
    return metadata.map((meta) => {
      // Convert numericValue to stringValue for API compatibility
      if (meta.numericValue !== undefined) {
        return { key: meta.key, stringValue: String(meta.numericValue) };
      }
      return meta;
    });
  }

  // Convert SimpleMetadata to CustomMetadata[]
  // All values are converted to strings for API compatibility
  return Object.entries(metadata).map(([key, value]) => {
    if (typeof value === 'string') {
      return { key, stringValue: value };
    } else if (typeof value === 'number') {
      // Convert to string for API compatibility
      return { key, stringValue: String(value) };
    } else if (Array.isArray(value)) {
      // For arrays, convert to StringList format { values: string[] }
      const stringArray = value.map((v) =>
        typeof v === 'string' ? v : String(v),
      );
      return { key, stringListValue: { values: stringArray } };
    } else {
      // Fallback: convert to string
      return { key, stringValue: String(value) };
    }
  });
}

/**
 * Chunking Configuration
 */
export const WhiteSpaceChunkingConfig = Schema.Struct({
  maxTokensPerChunk: Schema.Number,
  maxOverlapTokens: Schema.Number,
});

export type WhiteSpaceChunkingConfig = Schema.Schema.Type<
  typeof WhiteSpaceChunkingConfig
>;

export const ChunkingConfig = Schema.Struct({
  whiteSpaceConfig: Schema.optional(WhiteSpaceChunkingConfig),
});

export type ChunkingConfig = Schema.Schema.Type<typeof ChunkingConfig>;

/**
 * Upload Configuration
 * customMetadata can be either the structured CustomMetadata[] format
 * or a simple key-value object (SimpleMetadata) for convenience
 *
 * Note: We use Schema.Unknown for customMetadata since it can be either format,
 * and validation/conversion is handled by the toCustomMetadata helper function.
 */
export const UploadConfig = Schema.Struct({
  displayName: Schema.String,
  customMetadata: Schema.optional(Schema.Unknown),
  chunkingConfig: Schema.optional(ChunkingConfig),
});

export type UploadConfig = {
  displayName: string;
  customMetadata?: CustomMetadata[] | SimpleMetadata;
  chunkingConfig?: ChunkingConfig;
};

/**
 * Document
 */
export const Document = Schema.Struct({
  name: Schema.String,
  displayName: Schema.String,
  createTime: Schema.optional(Schema.String),
  updateTime: Schema.optional(Schema.String),
  customMetadata: Schema.optional(Schema.Array(CustomMetadata)),
});

export type Document = Schema.Schema.Type<typeof Document>;

/**
 * Generation Query Configuration
 */
export const FileSearchTool = Schema.Struct({
  fileSearch: Schema.Struct({
    fileSearchStoreNames: Schema.Array(Schema.String),
    metadataFilter: Schema.optional(Schema.String),
  }),
});

export type FileSearchTool = Schema.Schema.Type<typeof FileSearchTool>;

/**
 * Generation Response
 */
export const GroundingMetadata = Schema.Struct({
  searchEntryPoint: Schema.optional(Schema.String),
  retrievalMetadata: Schema.optional(
    Schema.Struct({
      score: Schema.optional(Schema.Number),
      chunk: Schema.optional(Schema.String),
    }),
  ),
});

export type GroundingMetadata = Schema.Schema.Type<typeof GroundingMetadata>;

export const Candidate = Schema.Struct({
  content: Schema.Struct({
    parts: Schema.Array(
      Schema.Struct({
        text: Schema.optional(Schema.String),
      }),
    ),
  }),
  groundingMetadata: Schema.optional(GroundingMetadata),
});

export type Candidate = Schema.Schema.Type<typeof Candidate>;

export const GenerationResponse = Schema.Struct({
  candidates: Schema.Array(Candidate),
});

export type GenerationResponse = Schema.Schema.Type<typeof GenerationResponse>;

/**
 * List Stores Response
 */
export const ListStoresResponse = Schema.Struct({
  stores: Schema.Array(FileSearchStore),
  nextPageToken: Schema.optional(Schema.String),
});

export type ListStoresResponse = Schema.Schema.Type<typeof ListStoresResponse>;

/**
 * List Documents Response
 */
export const ListDocumentsResponse = Schema.Struct({
  documents: Schema.Array(Document),
  nextPageToken: Schema.optional(Schema.String),
});

export type ListDocumentsResponse = Schema.Schema.Type<
  typeof ListDocumentsResponse
>;

/**
 * Operation (for polling)
 */
export const Operation = Schema.Struct({
  name: Schema.String,
  done: Schema.Boolean,
  error: Schema.optional(
    Schema.Struct({
      code: Schema.Number,
      message: Schema.String,
    }),
  ),
  response: Schema.optional(Schema.Unknown),
});

export type Operation = Schema.Schema.Type<typeof Operation>;
