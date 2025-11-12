/**
 * EGW API Schemas using Effect Schema
 * Based on the EGW API client reference implementation
 */

import { Schema } from "effect";

/**
 * Text Direction
 */
export const TextDirection = Schema.Literal("ltr", "rtl");

export type TextDirection = Schema.Schema.Type<typeof TextDirection>;

/**
 * Book Type
 * Common types: "book", "devotional", "bibleCommentary", "bible", "manuscript", "periodical", "dictionary", "topicalindex"
 * The API may return other types, so we accept any string.
 */
export const BookType = Schema.String;

export type BookType = Schema.Schema.Type<typeof BookType>;

/**
 * Permission Required
 */
export const PermissionRequired = Schema.Literal(
  "hidden",
  "public",
  "authenticated",
  "purchased"
);

export type PermissionRequired = Schema.Schema.Type<typeof PermissionRequired>;

/**
 * Language
 */
export const Language = Schema.Struct({
  code: Schema.String,
  name: Schema.String,
  direction: TextDirection,
});

export type Language = Schema.Schema.Type<typeof Language>;

/**
 * Folder - Base fields (non-recursive)
 */
const folderFields = {
  folder_id: Schema.Number,
  name: Schema.String,
  add_class: Schema.String,
  nbooks: Schema.Number,
  naudiobooks: Schema.Number,
  sort_order: Schema.optional(Schema.Number),
  parent_id: Schema.optional(Schema.Number),
} as const;

/**
 * Folder - Type interface for recursive schema
 */
export interface Folder extends Schema.Struct.Type<typeof folderFields> {
  readonly children?: ReadonlyArray<Folder>;
}

/**
 * Folder - Schema definition with recursive children
 */
export const Folder: Schema.Schema<Folder> = Schema.Struct({
  ...folderFields,
  children: Schema.optional(
    Schema.Array(Schema.suspend((): Schema.Schema<Folder> => Folder))
  ),
});

/**
 * Book Cover (BookCoverDto)
 */
export const BookCover = Schema.Struct({
  small: Schema.optional(Schema.Union(Schema.String, Schema.Null)),
  large: Schema.optional(Schema.Union(Schema.String, Schema.Null)),
});

export type BookCover = Schema.Schema.Type<typeof BookCover>;

/**
 * Book Files (BookFilesDto)
 */
export const BookFiles = Schema.Struct({
  mp3: Schema.optional(Schema.Union(Schema.String, Schema.Null)),
  pdf: Schema.optional(Schema.Union(Schema.String, Schema.Null)),
  epub: Schema.optional(Schema.Union(Schema.String, Schema.Null)),
  mobi: Schema.optional(Schema.Union(Schema.String, Schema.Null)),
});

export type BookFiles = Schema.Schema.Type<typeof BookFiles>;

/**
 * Book (BookDto)
 */
export const Book = Schema.Struct({
  book_id: Schema.Number,
  code: Schema.String,
  lang: Schema.String,
  type: BookType,
  subtype: Schema.optional(Schema.Union(Schema.String, Schema.Null)),
  title: Schema.String,
  first_para: Schema.optional(Schema.Union(Schema.String, Schema.Null)),
  author: Schema.String,
  description: Schema.optional(Schema.Union(Schema.String, Schema.Null)),
  npages: Schema.Number,
  isbn: Schema.optional(Schema.Union(Schema.String, Schema.Null)),
  publisher: Schema.optional(Schema.Union(Schema.String, Schema.Null)),
  pub_year: Schema.String,
  buy_link: Schema.optional(Schema.Union(Schema.String, Schema.Null)),
  folder_id: Schema.Number,
  folder_color_group: Schema.optional(Schema.Union(Schema.String, Schema.Null)),
  cover: BookCover,
  files: BookFiles,
  download: Schema.optional(Schema.Union(Schema.String, Schema.Null)),
  last_modified: Schema.optional(Schema.Union(Schema.String, Schema.Null)),
  permission_required: PermissionRequired,
  sort: Schema.Number,
  is_audiobook: Schema.Boolean,
  cite: Schema.optional(Schema.Union(Schema.String, Schema.Null)),
  original_book: Schema.optional(Schema.Union(Schema.String, Schema.Null)),
  translated_into: Schema.optional(Schema.Union(Schema.Array(Schema.String), Schema.Null)),
  nelements: Schema.Number,
});

export type Book = Schema.Schema.Type<typeof Book>;

/**
 * Table of Contents Item (TocDto)
 */
export const TocItem = Schema.Struct({
  para_id: Schema.optional(Schema.Union(Schema.String, Schema.Null)),
  level: Schema.Number,
  title: Schema.optional(Schema.Union(Schema.String, Schema.Null)),
  refcode_short: Schema.optional(Schema.Union(Schema.String, Schema.Null)),
  dup: Schema.optional(Schema.Union(Schema.String, Schema.Null)),
  mp3: Schema.optional(Schema.Union(Schema.String, Schema.Null)),
  puborder: Schema.Number,
});

export type TocItem = Schema.Schema.Type<typeof TocItem>;

/**
 * Paragraph (ParagraphDto)
 */
export const Paragraph = Schema.Struct({
  para_id: Schema.optional(Schema.Union(Schema.String, Schema.Null)),
  id_prev: Schema.optional(Schema.Union(Schema.String, Schema.Null)),
  id_next: Schema.optional(Schema.Union(Schema.String, Schema.Null)),
  refcode_1: Schema.optional(Schema.Union(Schema.String, Schema.Null)),
  refcode_2: Schema.optional(Schema.Union(Schema.String, Schema.Null)),
  refcode_3: Schema.optional(Schema.Union(Schema.String, Schema.Null)),
  refcode_4: Schema.optional(Schema.Union(Schema.String, Schema.Null)),
  refcode_short: Schema.optional(Schema.Union(Schema.String, Schema.Null)),
  refcode_long: Schema.optional(Schema.Union(Schema.String, Schema.Null)),
  element_type: Schema.optional(Schema.Union(Schema.String, Schema.Null)),
  element_subtype: Schema.optional(Schema.Union(Schema.String, Schema.Null)),
  content: Schema.optional(Schema.Union(Schema.String, Schema.Null)),
  puborder: Schema.Number,
});

export type Paragraph = Schema.Schema.Type<typeof Paragraph>;

/**
 * OAuth Token Response
 */
export const TokenResponse = Schema.Struct({
  access_token: Schema.String,
  refresh_token: Schema.optional(Schema.String),
  token_type: Schema.String,
  expires_in: Schema.Number,
  scope: Schema.String,
});

export type TokenResponse = Schema.Schema.Type<typeof TokenResponse>;

/**
 * Token Info
 */
export const TokenInfo = Schema.Struct({
  accessToken: Schema.String,
  refreshToken: Schema.optional(Schema.String),
  expiresAt: Schema.Number,
  scope: Schema.String,
});

export type TokenInfo = Schema.Schema.Type<typeof TokenInfo>;

/**
 * Search Parameters
 */
export const SearchParams = Schema.Struct({
  query: Schema.String,
  lang: Schema.optional(Schema.String),
  folder: Schema.optional(Schema.Number),
  book: Schema.optional(Schema.Number),
  highlight: Schema.optional(Schema.Boolean),
  limit: Schema.optional(Schema.Number),
  offset: Schema.optional(Schema.Number),
});

export type SearchParams = Schema.Schema.Type<typeof SearchParams>;

/**
 * Books Query Parameters
 */
export const BooksQueryParams = Schema.Struct({
  pubnr: Schema.optional(Schema.Array(Schema.Number)),
  since: Schema.optional(Schema.String), // date-time format
  type: Schema.optional(Schema.Array(BookType)),
  lang: Schema.optional(Schema.String),
  can_read: Schema.optional(Schema.String),
  has_mp3: Schema.optional(Schema.String),
  has_pdf: Schema.optional(Schema.String),
  has_epub: Schema.optional(Schema.String),
  has_mobi: Schema.optional(Schema.String),
  has_book: Schema.optional(Schema.String),
  page: Schema.optional(Schema.Number),
  search: Schema.optional(Schema.String),
  folder: Schema.optional(Schema.Number),
  trans: Schema.optional(Schema.Union(Schema.Literal("all"), Schema.String)),
  limit: Schema.optional(Schema.Number),
  offset: Schema.optional(Schema.Number),
});

export type BooksQueryParams = Schema.Schema.Type<typeof BooksQueryParams>;

/**
 * Chapter Content Parameters
 */
export const ChapterContentParams = Schema.Struct({
  highlight: Schema.optional(Schema.String),
  trans: Schema.optional(
    Schema.Union(
      Schema.Literal("all"),
      Schema.Array(Schema.String),
      Schema.String
    )
  ),
});

export type ChapterContentParams = Schema.Schema.Type<typeof ChapterContentParams>;
