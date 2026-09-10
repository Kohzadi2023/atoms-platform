import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

export const EXPECTED_TENANT_ID = "1dda8889-b5fc-43eb-857b-b1549e4b82c3";
export const EXPECTED_API_CLIENT_ID = "4299c3fb-7ce1-4d23-bd49-26c554b08dac";
export const EXPECTED_SCOPE = "access_as_user";
export const EXPECTED_ISSUER =
  `https://${EXPECTED_TENANT_ID}.ciamlogin.com/${EXPECTED_TENANT_ID}/v2.0`;

export function decodeJwtPayload(token) {
  if (typeof token !== "string" || token.length < 20) {
    throw new Error("Entra access token is missing or malformed");
  }
  const parts = token.trim().split(".");
  if (parts.length !== 3) throw new Error("Entra access token is not a JWT");
  const json = Buffer.from(parts[1], "base64url").toString("utf8");
  try {
    return JSON.parse(json);
  } catch {
    throw new Error("Entra access token payload is invalid JSON");
  }
}

export function validateEntraAccessTokenClaims(payload, nowSeconds = Math.floor(Date.now() / 1000)) {
  if (payload?.tid !== EXPECTED_TENANT_ID) {
    throw new Error("Entra access token tenant does not match Atoms staging");
  }
  if (payload?.iss !== EXPECTED_ISSUER) {
    throw new Error("Entra access token issuer does not match Atoms staging");
  }
  const audiences = Array.isArray(payload?.aud) ? payload.aud : [payload?.aud];
  if (!audiences.includes(EXPECTED_API_CLIENT_ID)) {
    throw new Error("Entra access token audience does not match the Control API");
  }
  const scopes = typeof payload?.scp === "string" ? payload.scp.split(/\s+/u) : [];
  if (!scopes.includes(EXPECTED_SCOPE)) {
    throw new Error("Entra access token is missing access_as_user");
  }
  if (!Number.isFinite(payload?.exp) || payload.exp <= nowSeconds + 30) {
    throw new Error("Entra access token is expired or too close to expiry");
  }
  if (typeof payload?.sub !== "string" || payload.sub.length === 0) {
    throw new Error("Entra access token has no subject");
  }
  return { subject: payload.sub };
}

async function readTokenFile(path) {
  if (!isAbsolute(path)) throw new Error("token file path must be absolute");
  const token = (await readFile(path, "utf8")).trim();
  validateEntraAccessTokenClaims(decodeJwtPayload(token));
  return token;
}

async function requestJson(fetchImplementation, url, token, label) {
  const response = await fetchImplementation(url, {
    method: "GET",
    redirect: "error",
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(30_000),
  });
  if (response.status !== 200) {
    throw new Error(`${label} returned HTTP ${String(response.status)}`);
  }
  try {
    return await response.json();
  } catch {
    throw new Error(`${label} returned invalid JSON`);
  }
}

export async function runEntraIdentitySmoke(configuration, dependencies = {}) {
  const fetchImplementation = dependencies.fetch ?? globalThis.fetch;
  const primaryPayload = validateEntraAccessTokenClaims(
    decodeJwtPayload(configuration.primaryToken),
  );
  const foreignPayload = validateEntraAccessTokenClaims(
    decodeJwtPayload(configuration.foreignToken),
  );
  if (primaryPayload.subject === foreignPayload.subject) {
    throw new Error("Entra smoke requires two distinct customer identities");
  }

  const primaryMe = await requestJson(
    fetchImplementation,
    new URL("/v1/me", configuration.controlApiOrigin),
    configuration.primaryToken,
    "primary Entra identity",
  );
  const foreignMe = await requestJson(
    fetchImplementation,
    new URL("/v1/me", configuration.controlApiOrigin),
    configuration.foreignToken,
    "foreign Entra identity",
  );

  if (typeof primaryMe?.userId !== "string" || typeof foreignMe?.userId !== "string") {
    throw new Error("Control API did not resolve both Entra identities");
  }
  if (primaryMe.userId === foreignMe.userId) {
    throw new Error("Control API collapsed two Entra identities into one user");
  }

  return {
    ok: true,
    checks: [
      "verified_entra_token_contract",
      "two_distinct_entra_subjects",
      "control_api_resolves_both_identities",
    ],
  };
}

function parseArguments(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (value === undefined) throw new Error(`${name} requires a value`);
    if (values.has(name)) throw new Error(`${name} may be supplied only once`);
    values.set(name, value);
  }
  const controlApiOrigin = values.get("--control-api-origin");
  const primaryTokenFile = values.get("--primary-token-file");
  const foreignTokenFile = values.get("--foreign-token-file");
  if (controlApiOrigin === undefined) throw new Error("--control-api-origin is required");
  if (primaryTokenFile === undefined) throw new Error("--primary-token-file is required");
  if (foreignTokenFile === undefined) throw new Error("--foreign-token-file is required");
  return { controlApiOrigin, primaryTokenFile, foreignTokenFile };
}

async function main() {
  try {
    const options = parseArguments(process.argv.slice(2));
    const controlApiOrigin = new URL(options.controlApiOrigin).origin;
    const primaryToken = await readTokenFile(resolve(options.primaryTokenFile));
    const foreignToken = await readTokenFile(resolve(options.foreignTokenFile));
    await runEntraIdentitySmoke({ controlApiOrigin, primaryToken, foreignToken });
    console.log("Entra staging identity smoke passed.");
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Entra staging identity smoke failed safely");
    process.exitCode = 1;
  }
}

if (process.argv[1]?.endsWith("smoke-staging-entra-auth.mjs")) {
  await main();
}
