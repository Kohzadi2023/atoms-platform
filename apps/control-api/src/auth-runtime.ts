import { z } from "zod";

import {
  type Authenticator,
  OidcJwtAuthenticator,
  StaticTokenAuthenticator,
} from "./auth.js";

export const AuthEnvironmentSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    AUTH_REQUIRED: z
      .enum(["true", "false"])
      .default("true")
      .transform((value) => value === "true"),
    AUTH_ISSUER_URL: z.string().trim().url().optional(),
    AUTH_AUDIENCE: z.string().trim().min(1).optional(),
    AUTH_JWKS_URL: z.string().trim().url().optional(),
    AUTH_ALLOWED_ALGORITHMS: z
      .string()
      .default("RS256")
      .transform((value) =>
        value
          .split(",")
          .map((entry) => entry.trim())
          .filter((entry) => entry.length > 0),
      )
      .pipe(z.array(z.string().min(1)).min(1).max(10)),
    AUTH_DEV_AUTHENTICATOR_ENABLED: z
      .enum(["true", "false"])
      .default("false")
      .transform((value) => value === "true"),
    AUTH_DEV_ACCESS_TOKEN: z.string().trim().min(32).optional(),
    AUTH_DEV_USER_ID: z
      .string()
      .trim()
      .min(1)
      .max(191)
      .default("local-demo-user"),
  })
  .strict();

export type AuthEnvironment = z.infer<typeof AuthEnvironmentSchema>;

export interface AuthRuntimeOptions {
  readonly authRequired: boolean;
  readonly authenticator: Authenticator | undefined;
}

export function resolveAuthRuntimeOptions(
  environment: AuthEnvironment,
): AuthRuntimeOptions {
  if (environment.NODE_ENV === "production" && !environment.AUTH_REQUIRED) {
    throw new Error("AUTH_REQUIRED must remain true in production");
  }
  if (
    environment.NODE_ENV === "production" &&
    environment.AUTH_DEV_AUTHENTICATOR_ENABLED
  ) {
    throw new Error(
      "AUTH_DEV_AUTHENTICATOR_ENABLED cannot be used in production",
    );
  }

  if (!environment.AUTH_REQUIRED) {
    return { authRequired: false, authenticator: undefined };
  }

  if (environment.AUTH_DEV_AUTHENTICATOR_ENABLED) {
    if (environment.AUTH_DEV_ACCESS_TOKEN === undefined) {
      throw new Error(
        "AUTH_DEV_ACCESS_TOKEN is required when AUTH_DEV_AUTHENTICATOR_ENABLED=true",
      );
    }
    const issuedAt = Math.floor(Date.now() / 1_000);
    return {
      authRequired: true,
      authenticator: new StaticTokenAuthenticator(
        new Map([
          [
            environment.AUTH_DEV_ACCESS_TOKEN,
            {
              userId: environment.AUTH_DEV_USER_ID,
              subject: environment.AUTH_DEV_USER_ID,
              issuer: "urn:atoms:dev-auth",
              audience: ["atoms-control-api"],
              issuedAt,
              notBefore: issuedAt,
              expiresAt: issuedAt + 24 * 60 * 60,
            },
          ],
        ]),
      ),
    };
  }

  if (
    environment.AUTH_ISSUER_URL === undefined ||
    environment.AUTH_AUDIENCE === undefined ||
    environment.AUTH_JWKS_URL === undefined
  ) {
    throw new Error(
      "AUTH_ISSUER_URL, AUTH_AUDIENCE, and AUTH_JWKS_URL are required when AUTH_REQUIRED=true",
    );
  }

  return {
    authRequired: true,
    authenticator: new OidcJwtAuthenticator({
      issuer: environment.AUTH_ISSUER_URL,
      audience: environment.AUTH_AUDIENCE,
      jwksUrl: environment.AUTH_JWKS_URL,
      allowedAlgorithms: environment.AUTH_ALLOWED_ALGORITHMS,
    }),
  };
}
