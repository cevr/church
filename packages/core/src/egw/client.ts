/**
 * EGW API Client using Effect-TS
 * Adapted from Spotify client patterns with Effect-TS
 */

import {
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
} from "@effect/platform";
import {
  Config,
  Data,
  Duration,
  Effect,
  Option,
  Redacted,
  Schedule,
  Schema,
  Stream,
} from "effect";
import { EGWAuth } from "./auth.js";
import * as Schemas from "./schemas.js";

/**
 * EGW API Client Errors
 */
export class EGWApiError extends Data.TaggedError("EGWApiError")<{
  readonly cause: unknown;
  readonly message: string;
}> {}

/**
 * EGW API Client Service
 */
export class EGWApiClient extends Effect.Service<EGWApiClient>()(
  "lib/EGW/Client",
  {
    effect: Effect.gen(function* () {
      const baseUrl = yield* Config.string("EGW_API_BASE_URL").pipe(
        Config.withDefault("https://a.egwwritings.org")
      );
      const userAgent = yield* Config.string("EGW_USER_AGENT").pipe(
        Config.withDefault("EGW-Effect-Client/1.0")
      );

      const auth = yield* EGWAuth;
      const rawHttpClient = yield* HttpClient.HttpClient;

      /**
       * Create an instrumented HTTP client with optional baseUrl prepending
       * @param prependBaseUrl - If true, prepends baseUrl to relative URLs
       */
      const createHttpClient = (prependBaseUrl: boolean) =>
        rawHttpClient.pipe(
          HttpClient.mapRequest((request) => {
            // Conditionally prepend baseUrl based on the parameter
            const withBaseUrl = prependBaseUrl
              ? HttpClientRequest.prependUrl(baseUrl)(request)
              : request;
            return withBaseUrl.pipe(
              HttpClientRequest.setHeader("User-Agent", userAgent),
              HttpClientRequest.acceptJson
            );
          }),
          HttpClient.mapRequestEffect((request) =>
            Effect.gen(function* () {
              const token = yield* auth.getToken();
              return HttpClientRequest.bearerToken(
                request,
                Redacted.value(token.accessToken)
              );
            })
          ),
          // Log outgoing requests
          HttpClient.tapRequest((request) =>
            Effect.logDebug(
              `-> req ${request.method} ${request.url}${new URLSearchParams(request.urlParams as any).toString()}`
            )
          ),
          // Log incoming responses
          HttpClient.transformResponse((responseEffect) =>
            responseEffect.pipe(
              Effect.tap((response) =>
                Effect.gen(function* () {
                  yield* Effect.logDebug(
                    `<- res ${response.status} ${response.request.method} ${response.request.url}`
                  );
                  // Log response body for non-2xx status codes
                  if (response.status < 200 || response.status >= 300) {
                    const body = yield* response.text.pipe(Effect.either);
                    if (body._tag === "Right") {
                      yield* Effect.logError(
                        "Error response body:",
                        body.right
                      );
                    }
                  }
                })
              )
            )
          ),
          // Log errors
          HttpClient.tapError((error) =>
            Effect.gen(function* () {
              const request =
                error && typeof error === "object" && "request" in error
                  ? (error as { request?: { method?: string; url?: string } })
                      .request
                  : undefined;
              yield* Effect.logError(
                `✗ res ${request?.method} ${request?.url}`,
                String(error)
              );
            })
          ),
          HttpClient.filterStatusOk
        );

      // Create HTTP client for relative URLs (with baseUrl prepending)
      const httpClient = createHttpClient(true);

      // Create HTTP client for absolute URLs (without baseUrl prepending)
      const absoluteUrlHttpClient = createHttpClient(false);

      /**
       * Retry schedule with exponential backoff
       * Maximum 3 retries (1 initial attempt + 2 retries)
       * Exponential delays: 100ms, 200ms, 400ms
       */
      const retrySchedule = Schedule.exponential(Duration.millis(100)).pipe(
        Schedule.compose(Schedule.recurs(2))
      );

      // Paginated response schema
      const PaginatedResponse = Schema.Struct({
        count: Schema.Number,
        ipp: Schema.Number,
        previous: Schema.Union(Schema.String, Schema.Null),
        next: Schema.Union(Schema.String, Schema.Null),
        results: Schema.Array(Schemas.Book),
      });

      type PaginatedResponse = Schema.Schema.Type<typeof PaginatedResponse>;

      /**
       * Fetch a single page of books from a URL
       * Handles both absolute URLs (from next field) and relative URLs
       */
      const fetchBooksPage = (
        url: string
      ): Effect.Effect<PaginatedResponse, EGWApiError> =>
        Effect.gen(function* () {
          // Determine if URL is absolute or relative
          const isAbsoluteUrl =
            url.startsWith("http://") || url.startsWith("https://");

          const response = yield* isAbsoluteUrl
            ? absoluteUrlHttpClient.get(url)
            : httpClient.get(url.startsWith("/") ? url : `/${url}`);

          return yield* HttpClientResponse.schemaBodyJson(PaginatedResponse)(
            response
          );
        }).pipe(
          Effect.catchAll((error) =>
            Effect.fail(
              new EGWApiError({
                message: `Failed to fetch books page: ${url}`,
                cause: error,
              })
            )
          ),
          Effect.retry(retrySchedule)
        );

      /**
       * Create a stream of books from paginated API responses
       * Uses Stream.paginateEffect to handle pagination automatically
       */
      const booksStream = (
        initialUrl: string
      ): Stream.Stream<Schemas.Book, EGWApiError> =>
        Stream.paginateEffect(initialUrl, (url) =>
          Effect.gen(function* () {
            const page = yield* fetchBooksPage(url);
            // Emit all books from this page, and continue with next URL if available
            return [
              page.results,
              page.next ? Option.some(page.next) : Option.none(),
            ] as const;
          })
        ).pipe(Stream.flatMap((books) => Stream.fromIterable(books)));

      return {
        getLanguages: () =>
          Effect.gen(function* () {
            const response = yield* httpClient.get("/content/languages");
            return yield* HttpClientResponse.schemaBodyJson(
              Schema.Array(Schemas.Language)
            )(response);
          }).pipe(Effect.retry(retrySchedule)),

        getFoldersByLanguage: (languageCode: string) =>
          Effect.gen(function* () {
            const response = yield* httpClient.get(
              `/content/languages/${languageCode}/folders`
            );
            return yield* HttpClientResponse.schemaBodyJson(
              Schema.Array(Schemas.Folder)
            )(response);
          }).pipe(Effect.retry(retrySchedule)),

        getBooksByFolder: (
          folderId: number,
          params: Partial<Schemas.BooksQueryParams> = {}
        ) =>
          Effect.gen(function* () {
            const urlParams = new URLSearchParams();
            if (params.trans) urlParams.append("trans", params.trans);
            if (params.limit) urlParams.append("limit", String(params.limit));
            if (params.offset)
              urlParams.append("offset", String(params.offset));
            if (params.page) urlParams.append("page", String(params.page));

            const queryString = urlParams.toString();
            const endpoint = `/content/books/by_folder/${folderId}${
              queryString ? `?${queryString}` : ""
            }`;

            const response = yield* httpClient.get(endpoint);
            return yield* HttpClientResponse.schemaBodyJson(
              Schema.Array(Schemas.Book)
            )(response);
          }).pipe(Effect.retry(retrySchedule)),

        getBooks: (
          params: Partial<Schemas.BooksQueryParams> = {}
        ): Stream.Stream<Schemas.Book, EGWApiError> => {
          const urlParams = new URLSearchParams();
          if (params.pubnr) {
            params.pubnr.forEach((id) => urlParams.append("pubnr", String(id)));
          }
          if (params.since) urlParams.append("since", params.since);
          if (params.type) {
            params.type.forEach((t) => urlParams.append("type", t));
          }
          if (params.lang) urlParams.append("lang", params.lang);
          if (params.can_read) urlParams.append("can_read", params.can_read);
          if (params.has_mp3) urlParams.append("has_mp3", params.has_mp3);
          if (params.has_pdf) urlParams.append("has_pdf", params.has_pdf);
          if (params.has_epub) urlParams.append("has_epub", params.has_epub);
          if (params.has_mobi) urlParams.append("has_mobi", params.has_mobi);
          if (params.has_book) urlParams.append("has_book", params.has_book);
          if (params.page) urlParams.append("page", String(params.page));
          if (params.search) urlParams.append("search", params.search);
          if (params.folder) urlParams.append("folder", String(params.folder));
          if (params.trans) {
            const transValue =
              typeof params.trans === "string" ? params.trans : "all";
            urlParams.append("trans", transValue);
          }
          if (params.limit) urlParams.append("limit", String(params.limit));
          if (params.offset) urlParams.append("offset", String(params.offset));

          const queryString = urlParams.toString();
          const endpoint = `/content/books${queryString ? `?${queryString}` : ""}`;

          // If page is explicitly specified, return a stream of that page's results
          // Otherwise, return a stream that fetches all pages
          if (params.page !== undefined) {
            return Stream.fromEffect(
              Effect.gen(function* () {
                const response = yield* httpClient.get(endpoint);
                const paginated =
                  yield* HttpClientResponse.schemaBodyJson(PaginatedResponse)(
                    response
                  );
                return paginated.results;
              }).pipe(
                Effect.mapError(
                  (error) =>
                    new EGWApiError({
                      message: `Failed to fetch books page: ${endpoint}`,
                      cause: error,
                    })
                ),
                Effect.retry(retrySchedule)
              )
            ).pipe(Stream.flatMap((books) => Stream.fromIterable(books)));
          }

          // Return stream of all books from all pages
          return booksStream(endpoint);
        },

        getBook: (bookId: number, params: { trans?: "all" | string } = {}) =>
          Effect.gen(function* () {
            const urlParams = new URLSearchParams();
            if (params.trans) urlParams.append("trans", params.trans);

            const queryString = urlParams.toString();
            const endpoint = `/content/books/${bookId}${
              queryString ? `?${queryString}` : ""
            }`;

            const response = yield* httpClient.get(endpoint);
            return yield* HttpClientResponse.schemaBodyJson(Schemas.Book)(
              response
            );
          }).pipe(Effect.retry(retrySchedule)),

        getBookToc: (bookId: number) =>
          Effect.gen(function* () {
            yield* Effect.log(`Getting table of contents: (ID: ${bookId})`);
            const response = yield* httpClient.get(
              `/content/books/${bookId}/toc`
            );
            // Try to parse, and if it fails, log the actual response for debugging
            const parsed = yield* HttpClientResponse.schemaBodyJson(
              Schema.Array(Schemas.TocItem)
            )(response).pipe(
              Effect.catchAll((error) =>
                Effect.gen(function* () {
                  const raw = yield* response.json;
                  yield* Effect.logError(
                    `Failed to parse TOC for book ${bookId}. Raw response:`,
                    JSON.stringify(raw, null, 2)
                  );
                  return yield* Effect.fail(error);
                })
              )
            );
            return parsed;
          }).pipe(Effect.retry(retrySchedule)),

        getChapterContent: (
          bookId: number,
          chapterId: string,
          params: Partial<Schemas.ChapterContentParams> = {}
        ) =>
          Effect.gen(function* () {
            const urlParams = new URLSearchParams();
            if (params.highlight)
              urlParams.append("highlight", params.highlight);
            if (params.trans) {
              if (params.trans === "all") {
                urlParams.append("trans", "all");
              } else if (Array.isArray(params.trans)) {
                params.trans.forEach((t) => urlParams.append("trans", t));
              } else if (typeof params.trans === "string") {
                urlParams.append("trans", params.trans);
              }
            }

            const queryString = urlParams.toString();
            const endpoint = `/content/books/${bookId}/chapter/${chapterId}${
              queryString ? `?${queryString}` : ""
            }`;

            const response = yield* httpClient.get(endpoint);
            return yield* HttpClientResponse.schemaBodyJson(
              Schema.Array(Schemas.Paragraph)
            )(response);
          }).pipe(Effect.retry(retrySchedule)),

        downloadBook: (bookId: number) =>
          Effect.gen(function* () {
            const response = yield* httpClient.get(
              `/content/books/${bookId}/download`
            );
            return yield* response.arrayBuffer;
          }).pipe(Effect.retry(retrySchedule)),

        search: (params: Schemas.SearchParams) =>
          Effect.gen(function* () {
            const urlParams = new URLSearchParams();
            urlParams.append("query", params.query);
            if (params.lang) urlParams.append("lang", params.lang);
            if (params.folder)
              urlParams.append("folder", String(params.folder));
            if (params.book) urlParams.append("book", String(params.book));
            if (params.highlight !== undefined)
              urlParams.append("highlight", String(params.highlight));
            if (params.limit) urlParams.append("limit", String(params.limit));
            if (params.offset)
              urlParams.append("offset", String(params.offset));

            const endpoint = `/search?${urlParams.toString()}`;
            const response = yield* httpClient.get(endpoint);
            return yield* HttpClientResponse.schemaBodyJson(Schema.Unknown)(
              response
            );
          }).pipe(Effect.retry(retrySchedule)),

        getSuggestions: (query: string, limit: number = 10) =>
          Effect.gen(function* () {
            const response = yield* httpClient.get(
              `/suggestions?query=${encodeURIComponent(query)}&limit=${limit}`
            );
            return yield* HttpClientResponse.schemaBodyJson(
              Schema.Array(Schema.String)
            )(response);
          }).pipe(Effect.retry(retrySchedule)),

        getBookCoverUrl: (bookId: number, size: "small" | "large" = "small") =>
          Effect.succeed(`${baseUrl}/covers/${bookId}?size=${size}`),

        getMirrors: () =>
          Effect.gen(function* () {
            const response = yield* httpClient.get("/content/mirrors");
            return yield* HttpClientResponse.schemaBodyJson(
              Schema.Array(Schema.String)
            )(response);
          }).pipe(Effect.retry(retrySchedule)),
      } as const;
    }),
    dependencies: [EGWAuth.Default],
  }
) {}
