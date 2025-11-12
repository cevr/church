/**
 * EGW Paragraph Database Service using SQLite
 *
 * This service stores EGW paragraphs in a SQLite database for local caching,
 * avoiding repeated HTTP calls to the EGW API.
 * Follows the same conventions as upload-status.ts
 *
 * Stores paragraphs with their content, linked to books via book_id.
 * Essential fields:
 * - book_id (foreign key to book)
 * - ref_code (refcode_short or refcode_long, primary identifier)
 * - para_id, content, puborder (paragraph data)
 * - book metadata (code, title, author) for quick lookups
 */

import { FileSystem, Path } from "@effect/platform";
import { Config, Data, Effect, Option, ParseResult, Schema, Stream } from "effect";
import { Database } from "bun:sqlite";
import * as EGWSchemas from "../egw/schemas.js";

/**
 * Database connection or initialization error
 */
export class DatabaseConnectionError extends Data.TaggedError(
  "DatabaseConnectionError"
)<{
  readonly cause: unknown;
  readonly message: string;
}> {}

/**
 * Database query execution error
 */
export class DatabaseQueryError extends Data.TaggedError("DatabaseQueryError")<{
  readonly cause: unknown;
  readonly operation: string;
  readonly bookId?: number;
}> {}

/**
 * Paragraph not found error
 */
export class ParagraphNotFoundError extends Data.TaggedError(
  "ParagraphNotFoundError"
)<{
  readonly bookId: number;
  readonly refCode: string;
}> {}

/**
 * Database schema initialization error
 */
export class SchemaInitializationError extends Data.TaggedError(
  "SchemaInitializationError"
)<{
  readonly cause: unknown;
  readonly message: string;
}> {}

/**
 * Union type for all paragraph database errors
 */
export type ParagraphDatabaseError =
  | DatabaseConnectionError
  | DatabaseQueryError
  | ParagraphNotFoundError
  | SchemaInitializationError;

/**
 * Paragraph Row type - stores paragraphs with book reference
 * Uses Schema.pick to select fields from the existing Paragraph schema,
 * then extends with book reference and database-specific fields
 */
export const ParagraphRow = EGWSchemas.Paragraph.pipe(
  Schema.pick(
    "para_id",
    "refcode_short",
    "refcode_long",
    "content",
    "puborder"
  ),
  Schema.extend(
    Schema.Struct({
      book_id: Schema.Number,
      // Store book metadata for quick lookups (denormalized)
      book_code: Schema.String,
      book_title: Schema.String,
      book_author: Schema.String,
      // Computed ref_code (refcode_short or refcode_long, used as primary identifier)
      ref_code: Schema.String,
      created_at: Schema.String,
      updated_at: Schema.String,
    })
  )
);

export type ParagraphRow = Schema.Schema.Type<typeof ParagraphRow>;

/**
 * EGW Paragraph Database Service
 */
export class EGWParagraphDatabase extends Effect.Service<EGWParagraphDatabase>()(
  "lib/EGWDB/ParagraphDatabase",
  {
    scoped: Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;

      // Get database file path from config or use default
      const dbFile = yield* Config.string("EGW_PARAGRAPH_DB").pipe(
        Config.withDefault("data/egw-paragraphs.db")
      );

      const dbPath = path.resolve(dbFile);

      // Ensure directory exists
      yield* fs
        .makeDirectory(path.dirname(dbPath), { recursive: true })
        .pipe(Effect.orDie);

      // Open database connection
      const db = yield* Effect.try({
        try: () => new Database(dbPath),
        catch: (error) =>
          new DatabaseConnectionError({
            message: `Failed to open database at ${dbPath}`,
            cause: error,
          }),
      });

      // Initialize schema - paragraphs table
      yield* Effect.try({
        try: () => {
          db.run(`
            CREATE TABLE IF NOT EXISTS paragraphs (
              book_id INTEGER NOT NULL,
              ref_code TEXT NOT NULL,
              para_id TEXT,
              refcode_short TEXT,
              refcode_long TEXT,
              content TEXT,
              puborder INTEGER NOT NULL,
              book_code TEXT NOT NULL,
              book_title TEXT NOT NULL,
              book_author TEXT NOT NULL,
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL,
              PRIMARY KEY (book_id, ref_code)
            )
          `);
          db.run(`
            CREATE INDEX IF NOT EXISTS idx_paragraphs_book_id
            ON paragraphs(book_id)
          `);
          db.run(`
            CREATE INDEX IF NOT EXISTS idx_paragraphs_ref_code
            ON paragraphs(ref_code)
          `);
          db.run(`
            CREATE INDEX IF NOT EXISTS idx_paragraphs_book_author
            ON paragraphs(book_author)
          `);
          db.run(`
            CREATE INDEX IF NOT EXISTS idx_paragraphs_puborder
            ON paragraphs(book_id, puborder)
          `);
        },
        catch: (error) =>
          new SchemaInitializationError({
            message: "Failed to initialize database schema",
            cause: error,
          }),
      });

      // Prepared statements for better performance
      const insertOrUpdateParagraphQuery = db.query(`
        INSERT INTO paragraphs (
          book_id, ref_code, para_id, refcode_short, refcode_long,
          content, puborder, book_code, book_title, book_author,
          created_at, updated_at
        ) VALUES (
          $bookId, $refCode, $paraId, $refcodeShort, $refcodeLong,
          $content, $puborder, $bookCode, $bookTitle, $bookAuthor,
          $createdAt, $updatedAt
        )
        ON CONFLICT(book_id, ref_code) DO UPDATE SET
          para_id = excluded.para_id,
          refcode_short = excluded.refcode_short,
          refcode_long = excluded.refcode_long,
          content = excluded.content,
          puborder = excluded.puborder,
          book_code = excluded.book_code,
          book_title = excluded.book_title,
          book_author = excluded.book_author,
          updated_at = excluded.updated_at
      `);

      const getParagraphByRefCodeQuery = db.query<
        ParagraphRow,
        { $bookId: number; $refCode: string }
      >(`
        SELECT * FROM paragraphs
        WHERE book_id = $bookId AND ref_code = $refCode
      `);

      const getParagraphsByBookQuery = db.query<
        ParagraphRow,
        { $bookId: number }
      >(`
        SELECT * FROM paragraphs
        WHERE book_id = $bookId
        ORDER BY puborder
      `);

      const getParagraphsByAuthorQuery = db.query<
        ParagraphRow,
        { $author: string }
      >(`
        SELECT * FROM paragraphs
        WHERE book_author = $author
        ORDER BY book_id, puborder
      `);

      const getDistinctBooksByAuthorQuery = db.query<
        { book_id: number; book_code: string; book_title: string },
        { $author: string }
      >(`
        SELECT DISTINCT book_id, book_code, book_title
        FROM paragraphs
        WHERE book_author = $author
        ORDER BY book_id
      `);

      /**
       * Convert Paragraph schema to database row format using Effect Schema
       * Computes ref_code from refcode_short or refcode_long
       */
      const paragraphToRow = (
        paragraph: EGWSchemas.Paragraph,
        book: EGWSchemas.Book,
        now: string
      ): Effect.Effect<ParagraphRow, ParseResult.ParseError> => {
        const refCode =
          paragraph.refcode_short ??
          paragraph.refcode_long ??
          paragraph.para_id ??
          `book-${book.book_id}-para-${paragraph.puborder}`;

        return Schema.encode(ParagraphRow)({
          para_id: paragraph.para_id ?? null,
          refcode_short: paragraph.refcode_short ?? null,
          refcode_long: paragraph.refcode_long ?? null,
          content: paragraph.content ?? null,
          puborder: paragraph.puborder,
          book_id: book.book_id,
          book_code: book.code,
          book_title: book.title,
          book_author: book.author,
          ref_code: refCode,
          created_at: now,
          updated_at: now,
        });
      };

      /**
       * Convert database row to Paragraph schema
       * Note: This returns a paragraph object excluding database-specific fields
       */
      const rowToParagraph = (
        row: ParagraphRow
      ): Effect.Effect<EGWSchemas.Paragraph, ParseResult.ParseError> =>
        Schema.decode(ParagraphRow)(row).pipe(
          Effect.map((paragraphRow): EGWSchemas.Paragraph => ({
            para_id: paragraphRow.para_id ?? null,
            id_prev: null,
            id_next: null,
            refcode_1: null,
            refcode_2: null,
            refcode_3: null,
            refcode_4: null,
            refcode_short: paragraphRow.refcode_short ?? null,
            refcode_long: paragraphRow.refcode_long ?? null,
            element_type: null,
            element_subtype: null,
            content: paragraphRow.content ?? null,
            puborder: paragraphRow.puborder,
          }))
        );

      /**
       * Store or update a paragraph in the database
       */
      const storeParagraph = (
        paragraph: EGWSchemas.Paragraph,
        book: EGWSchemas.Book
      ): Effect.Effect<void, ParagraphDatabaseError | ParseResult.ParseError> =>
        Effect.gen(function* () {
          const now = new Date().toISOString();

          // Compute ref_code
          const refCode =
            paragraph.refcode_short ??
            paragraph.refcode_long ??
            paragraph.para_id ??
            `book-${book.book_id}-para-${paragraph.puborder}`;

          // Check if paragraph exists to preserve created_at
          const existing = yield* Effect.try({
            try: () =>
              getParagraphByRefCodeQuery.get({
                $bookId: book.book_id,
                $refCode: refCode,
              }),
            catch: (error) =>
              new DatabaseQueryError({
                operation: "getParagraph",
                bookId: book.book_id,
                cause: error,
              }),
          });

          // Convert paragraph to row using Schema
          const row = yield* paragraphToRow(
            paragraph,
            book,
            existing?.created_at || now
          );

          yield* Effect.try({
            try: () => {
              insertOrUpdateParagraphQuery.run({
                $bookId: row.book_id,
                $refCode: row.ref_code,
                $paraId: row.para_id ?? null,
                $refcodeShort: row.refcode_short ?? null,
                $refcodeLong: row.refcode_long ?? null,
                $content: row.content ?? null,
                $puborder: row.puborder,
                $bookCode: row.book_code,
                $bookTitle: row.book_title,
                $bookAuthor: row.book_author,
                $createdAt: row.created_at,
                $updatedAt: row.updated_at,
              });
            },
            catch: (error) =>
              new DatabaseQueryError({
                operation: "storeParagraph",
                bookId: book.book_id,
                cause: error,
              }),
          });
        });

      /**
       * Get a paragraph by book_id and ref_code
       */
      const getParagraph = (
        bookId: number,
        refCode: string
      ): Effect.Effect<
        Option.Option<EGWSchemas.Paragraph>,
        ParagraphDatabaseError | ParseResult.ParseError
      > =>
        Effect.gen(function* () {
          const row = yield* Effect.try({
            try: () =>
              getParagraphByRefCodeQuery.get({
                $bookId: bookId,
                $refCode: refCode,
              }),
            catch: (error) =>
              new DatabaseQueryError({
                operation: "getParagraph",
                bookId: bookId,
                cause: error,
              }),
          });

          if (!row) {
            return yield* Effect.succeed(Option.none());
          }

          const paragraph = yield* rowToParagraph(row);
          return yield* Effect.succeed(Option.some(paragraph));
        });

      /**
       * Get all paragraphs for a book
       */
      const getParagraphsByBook = (
        bookId: number
      ): Stream.Stream<
        EGWSchemas.Paragraph,
        ParagraphDatabaseError | ParseResult.ParseError
      > =>
        Stream.fromEffect(
          Effect.try({
            try: () =>
              getParagraphsByBookQuery.all({
                $bookId: bookId,
              }),
            catch: (error) =>
              new DatabaseQueryError({
                operation: "getParagraphsByBook",
                bookId: bookId,
                cause: error,
              }),
          })
        ).pipe(
          Stream.flatMap((rows) => Stream.fromIterable(rows)),
          Stream.mapEffect((row) => rowToParagraph(row))
        );

      /**
       * Get all paragraphs by author
       */
      const getParagraphsByAuthor = (
        author: string
      ): Stream.Stream<
        EGWSchemas.Paragraph,
        ParagraphDatabaseError | ParseResult.ParseError
      > =>
        Stream.fromEffect(
          Effect.try({
            try: () =>
              getParagraphsByAuthorQuery.all({
                $author: author,
              }),
            catch: (error) =>
              new DatabaseQueryError({
                operation: "getParagraphsByAuthor",
                cause: error,
              }),
          })
        ).pipe(
          Stream.flatMap((rows) => Stream.fromIterable(rows)),
          Stream.mapEffect((row) => rowToParagraph(row))
        );

      /**
       * Get distinct books by author (for listing books)
       * Returns simplified book info extracted from paragraphs
       */
      const getBooksByAuthor = (
        author: string
      ): Stream.Stream<
        {
          readonly book_id: number;
          readonly book_code: string;
          readonly book_title: string;
        },
        ParagraphDatabaseError
      > =>
        Stream.fromEffect(
          Effect.try({
            try: () =>
              getDistinctBooksByAuthorQuery.all({
                $author: author,
              }),
            catch: (error) =>
              new DatabaseQueryError({
                operation: "getBooksByAuthor",
                cause: error,
              }),
          })
        ).pipe(Stream.flatMap((rows) => Stream.fromIterable(rows)));

      // Cleanup: close database when scope ends
      yield* Effect.addFinalizer(() =>
        Effect.try({
          try: () => {
            db.close(false); // Allow pending queries to finish
          },
          catch: (error) =>
            new DatabaseConnectionError({
              message: "Failed to close database connection",
              cause: error,
            }),
        }).pipe(Effect.ignore)
      );

      return {
        storeParagraph,
        getParagraph,
        getParagraphsByBook,
        getParagraphsByAuthor,
        getBooksByAuthor,
      } as const;
    }),
    dependencies: [],
  }
) {}
