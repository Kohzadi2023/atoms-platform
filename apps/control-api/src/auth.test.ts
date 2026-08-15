import assert from "node:assert/strict";
import http from "node:http";
import type { KeyObject, webcrypto } from "node:crypto";
import test from "node:test";

import {
  SignJWT,
  exportJWK,
  generateKeyPair,
  type JWK,
} from "jose";

import {
  createDeterministicTestAuthenticator,
  InvalidAccessTokenError,
  OidcJwtAuthenticator,
  parseBearerToken,
} from "./auth.js";

const ISSUER = "https://issuer.example.test/";
const AUDIENCE = "atoms-control-api";

interface JwksServer {
  readonly url: string;
  close(): Promise<void>;
}

test("OIDC authenticator verifies signature and claims", async () => {
  const signingKeys = await generateSigningKeys("kid-primary");
  const jwksServer = await startJwksServer(signingKeys.publicJwk);

  try {
    const authenticator = new OidcJwtAuthenticator({
      issuer: ISSUER,
      audience: AUDIENCE,
      jwksUrl: jwksServer.url,
      allowedAlgorithms: ["RS256"],
    });

    const valid = await authenticator.authenticate(
      await createToken(signingKeys.privateKey, {
        sub: "user-123",
      }),
    );
    assert.equal(valid.userId, "user-123");

    const wrongIssuerToken = await createToken(signingKeys.privateKey, {
      sub: "user-123",
      iss: "https://other-issuer.example.test/",
    });
    await assert.rejects(
      authenticator.authenticate(wrongIssuerToken),
      InvalidAccessTokenError,
    );

    const wrongAudienceToken = await createToken(signingKeys.privateKey, {
      sub: "user-123",
      aud: "other-audience",
    });
    await assert.rejects(
      authenticator.authenticate(wrongAudienceToken),
      InvalidAccessTokenError,
    );

    const expiredToken = await createToken(signingKeys.privateKey, {
      sub: "user-123",
      exp: Math.floor(Date.now() / 1_000) - 60,
      nbf: Math.floor(Date.now() / 1_000) - 300,
    });
    await assert.rejects(
      authenticator.authenticate(expiredToken),
      InvalidAccessTokenError,
    );

    const attackerKeys = await generateSigningKeys("kid-attacker");
    const invalidSignatureToken = await createToken(attackerKeys.privateKey, {
      sub: "user-123",
    });
    await assert.rejects(
      authenticator.authenticate(invalidSignatureToken),
      InvalidAccessTokenError,
    );

    const unsignedToken = [
      Buffer.from('{"alg":"none","typ":"JWT"}').toString("base64url"),
      Buffer.from(
        JSON.stringify({
          sub: "user-123",
          iss: ISSUER,
          aud: AUDIENCE,
          exp: Math.floor(Date.now() / 1_000) + 300,
        }),
      ).toString("base64url"),
      "",
    ].join(".");
    await assert.rejects(
      authenticator.authenticate(unsignedToken),
      InvalidAccessTokenError,
    );
  } finally {
    await jwksServer.close();
  }
});

test("bearer token parsing is strict", () => {
  assert.equal(parseBearerToken(undefined), null);
  assert.equal(parseBearerToken("Basic abc"), null);
  assert.equal(parseBearerToken("Bearer"), null);
  assert.equal(parseBearerToken("Bearer token extra"), null);
  assert.equal(parseBearerToken("Bearer token-123"), "token-123");
});

test("deterministic test authenticator returns injected principal", async () => {
  const authenticator = createDeterministicTestAuthenticator({
    accessToken: "fixture-token",
    principal: {
      userId: "user-fixture",
      subject: "sub-fixture",
      audience: ["atoms-control-api"],
    },
  });

  const principal = await authenticator.authenticate("fixture-token");
  assert.equal(principal.userId, "user-fixture");
  assert.equal(principal.subject, "sub-fixture");

  await assert.rejects(
    authenticator.authenticate("unknown-fixture-token"),
    InvalidAccessTokenError,
  );
});

async function generateSigningKeys(kid: string): Promise<{
  readonly privateKey: KeyObject | webcrypto.CryptoKey;
  readonly publicJwk: JWK;
}> {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const publicJwk = await exportJWK(publicKey);
  publicJwk.kid = kid;
  publicJwk.alg = "RS256";
  publicJwk.use = "sig";
  return { privateKey, publicJwk };
}

async function createToken(
  privateKey: KeyObject | webcrypto.CryptoKey,
  claims: {
    readonly sub: string;
    readonly iss?: string;
    readonly aud?: string;
    readonly exp?: number;
    readonly nbf?: number;
  },
): Promise<string> {
  const issuedAt = Math.floor(Date.now() / 1_000);
  const payload = new SignJWT({})
    .setProtectedHeader({ alg: "RS256", typ: "JWT" })
    .setSubject(claims.sub)
    .setIssuer(claims.iss ?? ISSUER)
    .setAudience(claims.aud ?? AUDIENCE)
    .setIssuedAt(issuedAt)
    .setNotBefore(claims.nbf ?? issuedAt - 5)
    .setExpirationTime(claims.exp ?? issuedAt + 300);
  return payload.sign(privateKey);
}

async function startJwksServer(publicJwk: JWK): Promise<JwksServer> {
  const server = http.createServer((request, response) => {
    if (request.url !== "/.well-known/jwks.json") {
      response.statusCode = 404;
      response.end();
      return;
    }
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ keys: [publicJwk] }));
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });

  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("JWKS server failed to bind");
  }

  return {
    url: `http://127.0.0.1:${String(address.port)}/.well-known/jwks.json`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      }),
  };
}
