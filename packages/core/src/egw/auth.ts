/**
 * EGW Authentication Service using Effect-TS
 * Adapted from Spotify auth patterns with Effect-TS
 */

import {
  FileSystem,
  HttpBody,
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
  Path,
  UrlParams,
} from '@effect/platform';
import {
  Clock,
  Config,
  Data,
  Duration,
  Effect,
  Option,
  Predicate,
  Redacted,
  Schedule,
  Schema,
  SynchronizedRef,
} from 'effect';

/**
 * EGW Auth Errors
 */
export class EGWAuthError extends Data.TaggedError('EGWAuthError')<{
  readonly cause: unknown;
  readonly message: string;
}> {}

/**
 * OAuth Token Response from API
 */
const OAuthTokenResponse = Schema.Struct({
  access_token: Schema.String,
  refresh_token: Schema.optional(Schema.String),
  token_type: Schema.String,
  expires_in: Schema.Number,
  scope: Schema.String,
});

/**
 * Access Token with creation timestamp
 */
export class AccessToken extends Schema.Class<AccessToken>(
  'lib/EGW/Auth/AccessToken',
)({
  accessToken: Schema.Redacted(Schema.NonEmptyString),
  refreshToken: Schema.optional(Schema.Redacted(Schema.NonEmptyString)),
  expiresAt: Schema.Int,
  scope: Schema.String,
}) {
  static fromJson = Schema.decode(Schema.parseJson(this));
  static toJson = Schema.encode(Schema.parseJson(this));

  isExpired(now: number): boolean {
    return this.expiresAt <= now;
  }
}

/**
 * Transform OAuth token response to AccessToken
 */
const AccessTokenFromOAuthResponse = Schema.transformOrFail(
  OAuthTokenResponse,
  Schema.typeSchema(AccessToken),
  {
    strict: true,
    decode: (encoded) =>
      Effect.gen(function* () {
        const createdAt = yield* Clock.currentTimeMillis;
        const expiresIn = encoded.expires_in * 1000;
        return new AccessToken(
          {
            accessToken: Redacted.make(encoded.access_token),
            refreshToken: encoded.refresh_token
              ? Redacted.make(encoded.refresh_token)
              : undefined,
            expiresAt: createdAt + expiresIn,
            scope: encoded.scope,
          },
          { disableValidation: true },
        );
      }),
    encode: (decoded) =>
      Effect.succeed({
        access_token: Redacted.value(decoded.accessToken),
        refresh_token: decoded.refreshToken
          ? Redacted.value(decoded.refreshToken)
          : undefined,
        token_type: 'Bearer',
        expires_in: Math.floor((decoded.expiresAt - Date.now()) / 1000),
        scope: decoded.scope,
      }),
  },
);

/**
 * EGW Authentication Service
 */
export class EGWAuth extends Effect.Service<EGWAuth>()('lib/EGW/Auth', {
  scoped: Effect.gen(function* () {
    const authBaseUrl = yield* Config.string('EGW_AUTH_BASE_URL').pipe(
      Config.withDefault('https://cpanel.egwwritings.org'),
    );
    const clientId = yield* Config.string('EGW_CLIENT_ID');
    const clientSecret = yield* Config.redacted('EGW_CLIENT_SECRET');
    const scope = yield* Config.string('EGW_SCOPE').pipe(
      Config.withDefault('writings search studycenter subscriptions user_info'),
    );
    const tokenFile = yield* Config.string('EGW_TOKEN_FILE').pipe(
      Config.withDefault('data/tokens.json'),
    );

    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;

    const tokenFilePath = path.resolve(tokenFile);

    // Ensure directory exists
    yield* fs
      .makeDirectory(path.dirname(tokenFilePath), { recursive: true })
      .pipe(Effect.orDie);

    const readTokenFromCache = Effect.fn('EGWAuth.readTokenFromCache')(
      function* () {
        const exists = yield* fs.exists(tokenFilePath);
        if (!exists) {
          return yield* Effect.succeed(Option.none());
        }
        const json = yield* fs.readFileString(tokenFilePath, 'utf-8');
        const token = yield* AccessToken.fromJson(json);
        return yield* Effect.succeed(Option.some(token));
      },
    );

    const writeTokenToCache = Effect.fn('EGWAuth.writeTokenToCache')(function* (
      token: AccessToken,
    ) {
      const json = yield* AccessToken.toJson(token);
      yield* fs.writeFileString(tokenFilePath, json);
    });

    const httpClient = (yield* HttpClient.HttpClient).pipe(
      HttpClient.mapRequest((request) =>
        request.pipe(
          HttpClientRequest.prependUrl(authBaseUrl),
          HttpClientRequest.basicAuth(clientId, Redacted.value(clientSecret)),
          HttpClientRequest.acceptJson,
        ),
      ),
      HttpClient.tapRequest((request) => {
        if (
          request.body._tag === 'Uint8Array' &&
          request.body.contentType.includes('json')
        ) {
          const text = new TextDecoder().decode(request.body.body);
          try {
            const json = JSON.parse(text);
            // Mask sensitive fields
            const maskedJson = {
              ...json,
              client_secret: json.client_secret ? '[REDACTED]' : undefined,
              refresh_token: json.refresh_token ? '[REDACTED]' : undefined,
            };
            return Effect.log(
              `-> req ${request.method} ${request.url}`,
              JSON.stringify(maskedJson),
            );
          } catch {
            return Effect.log(`-> req ${request.method} ${request.url}`);
          }
        }
        return Effect.log(`-> req ${request.method} ${request.url}`);
      }),
      HttpClient.transformResponse((responseEffect) =>
        responseEffect.pipe(
          Effect.tap((response) =>
            Effect.gen(function* () {
              yield* Effect.log(
                `<- res ${response.status} ${response.request.method} ${response.request.url}`,
              );
              // Log response body for non-2xx status codes
              if (response.status < 200 || response.status >= 300) {
                const body = yield* response.text.pipe(Effect.either);
                if (body._tag === 'Right') {
                  yield* Effect.logError('Error response body:', body.right);
                }
              }
            }),
          ),
        ),
      ),
      HttpClient.tapError((error) =>
        Effect.gen(function* () {
          const request = 'request' in error ? error.request : undefined;
          yield* Effect.logError(
            `✗ res ${request?.method} ${request?.url}`,
            String(error),
          );
        }),
      ),
      HttpClient.filterStatusOk,
    );

    const fetchToken = Effect.fn('EGWAuth.fetchToken')(function* () {
      // When using Basic Auth, don't include client_id and client_secret in body
      const token = yield* httpClient
        .post('/connect/token', {
          body: HttpBody.urlParams(
            UrlParams.fromInput({
              grant_type: 'client_credentials',
              scope: scope,
            }),
          ),
        })
        .pipe(
          Effect.flatMap(
            HttpClientResponse.schemaBodyJson(AccessTokenFromOAuthResponse),
          ),
        );

      yield* writeTokenToCache(token);

      return token;
    }, Effect.orDie);

    const refreshToken = Effect.fn('EGWAuth.refreshToken')(function* (
      token: AccessToken,
    ) {
      if (!token.refreshToken) {
        return yield* Effect.fail(
          new EGWAuthError({
            message: 'No refresh token available',
            cause: undefined,
          }),
        );
      }

      yield* Effect.logDebug('Refreshing EGW access token');

      const refreshedToken = yield* httpClient
        .post('/connect/token', {
          body: HttpBody.urlParams(
            UrlParams.fromInput({
              grant_type: 'refresh_token',
              refresh_token: Redacted.value(token.refreshToken),
            }),
          ),
        })
        .pipe(
          Effect.flatMap(
            HttpClientResponse.schemaBodyJson(AccessTokenFromOAuthResponse),
          ),
          Effect.flatMap((response) =>
            Clock.currentTimeMillis.pipe(
              Effect.map((createdAt) => {
                // The response from AccessTokenFromOAuthResponse already has expiresAt calculated
                return new AccessToken(
                  {
                    accessToken: response.accessToken,
                    refreshToken: Predicate.isNotUndefined(
                      response.refreshToken,
                    )
                      ? response.refreshToken
                      : token.refreshToken,
                    expiresAt: response.expiresAt,
                    scope: response.scope,
                  },
                  { disableValidation: true },
                );
              }),
            ),
          ),
        );

      yield* writeTokenToCache(refreshedToken);

      return refreshedToken;
    }, Effect.orDie);

    const refreshTokenIfExpired = Effect.fn('EGWAuth.refreshTokenIfExpired')(
      function* (token: AccessToken) {
        const now = yield* Clock.currentTimeMillis;
        // Refresh if expired or expiring within 5 minutes
        const fiveMinutes = Duration.minutes(5);
        return yield* token.isExpired(now - Duration.toMillis(fiveMinutes))
          ? refreshToken(token)
          : Effect.succeed(token);
      },
    );

    const initialToken = yield* readTokenFromCache().pipe(
      Effect.flatMap((maybeToken) =>
        maybeToken._tag === 'Some'
          ? refreshTokenIfExpired(maybeToken.value)
          : fetchToken(),
      ),
    );

    const tokenRef = yield* SynchronizedRef.make(initialToken);

    const getToken = Effect.fn('EGWAuth.getToken')(() =>
      SynchronizedRef.updateAndGetEffect(tokenRef, refreshTokenIfExpired),
    );

    // Periodically refresh token
    yield* getToken().pipe(
      Effect.interruptible,
      Effect.scheduleForked(Schedule.cron('0 0 * * *')),
    );

    return {
      getToken,
    } as const;
  }),
}) {}
