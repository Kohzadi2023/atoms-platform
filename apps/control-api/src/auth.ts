import { createRemoteJWKSet, jwtVerify } from "jose";

export interface AuthenticatedPrincipal {
  readonly userId: string;
  readonly subject: string;
  readonly issuer: string;
  readonly audience: readonly string[];
  readonly issuedAt: number | null;
  readonly notBefore: number | null;
  readonly expiresAt: number;
}

export interface Authenticator {
  authenticate(accessToken: string): Promise<AuthenticatedPrincipal>;
}

export interface OidcJwtAuthenticatorOptions {
  readonly issuer: string;
  readonly audience: string;
  readonly jwksUrl: string;
  readonly allowedAlgorithms: readonly string[];
}

export class InvalidAccessTokenError extends Error {
  override readonly name = "InvalidAccessTokenError";
}

export class OidcJwtAuthenticator implements Authenticator {
  readonly #issuer: string;
  readonly #audience: string;
  readonly #allowedAlgorithms: readonly string[];
  readonly #jwks: ReturnType<typeof createRemoteJWKSet>;

  constructor(options: OidcJwtAuthenticatorOptions) {
    this.#issuer = options.issuer;
    this.#audience = options.audience;
    this.#allowedAlgorithms = [...options.allowedAlgorithms];
    this.#jwks = createRemoteJWKSet(new URL(options.jwksUrl));
  }

  async authenticate(accessToken: string): Promise<AuthenticatedPrincipal> {
    try {
      const verified = await jwtVerify(accessToken, this.#jwks, {
        issuer: this.#issuer,
        audience: this.#audience,
        algorithms: [...this.#allowedAlgorithms],
      });

      const { payload } = verified;
      if (typeof payload.sub !== "string" || payload.sub.trim().length === 0) {
        throw new InvalidAccessTokenError("Token subject claim is missing");
      }
      if (typeof payload.exp !== "number") {
        throw new InvalidAccessTokenError("Token expiration claim is missing");
      }

      const audience = Array.isArray(payload.aud)
        ? payload.aud
        : payload.aud === undefined
          ? []
         : [payload.aud];

      return {
        userId: payload.sub,
        subject: payload.sub,
        issuer: payload.iss ?? this.#issuer,
        audience,
        issuedAt: typeof payload.iat === "number" ? payload.iat : null,
        notBefore: typeof payload.nbf === "number" ? payload.nbf : null,
        expiresAt: payload.exp,
      };
    } catch (error) {
      if (error instanceof InvalidAccessTokenError) {
        throw error;
      }
      throw new InvalidAccessTokenError(
        error instanceof Error ? error.message : "Access token is invalid",
      );
    }
  }
}

export class StaticTokenAuthenticator implements Authenticator {
  readonly #tokens: ReadonlyMap<string, AuthenticatedPrincipal>;

  constructor(tokens: ReadonlyMap<string, AuthenticatedPrincipal>) {
    this.#tokens = tokens;
  }

  async authenticate(accessToken: string): Promise<AuthenticatedPrincipal> {
    const principal = this.#tokens.get(accessToken);
    if (principal === undefined) {
      throw new InvalidAccessTokenError("Access token is not recognized");
    }
    return principal;
  }
}

export function createDeterministicTestAuthenticator(options: {
  readonly accessToken?: string;
  readonly principal?: Partial<AuthenticatedPrincipal>;
} = {}): Authenticator {
  const now = Math.floor(new Date("2026-01-01T00:00:00.000Z").getTime() / 1_000);
  const principal: AuthenticatedPrincipal = {
    userId: options.principal?.userId ?? "user-test",
    subject: options.principal?.subject ?? options.principal?.userId ?? "user-test",
    issuer: options.principal?.issuer ?? "https://auth.example.test/",
    audience: options.principal?.audience ?? ["atoms-control-api"],
    issuedAt: options.principal?.issuedAt ?? now,
    notBefore: options.principal?.notBefore ?? now,
    expiresAt: options.principal?.expiresAt ?? now + 3600,
  };
  const accessToken = options.accessToken ?? "test-access-token";
  return new StaticTokenAuthenticator(new Map([[accessToken, principal]]));
}

export function parseBearerToken(
  authorizationHeader: string | undefined,
): string | null {
  if (authorizationHeader === undefined) return null;
  const [scheme, token, ...rest] = authorizationHeader.trim().split(/\s+/u);
  if (rest.length > 0) return null;
  if (scheme?.toLowerCase() !== "bearer") return null;
  if (token === undefined || token.length === 0) return null;
  return token;
}

declare module "fastify" {
  interface FastifyRequest {
    principal?: AuthenticatedPrincipal;
  }
}
