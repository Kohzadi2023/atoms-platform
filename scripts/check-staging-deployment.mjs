import { lstat, readFile, realpath } from "node:fs/promises";
import { isIP } from "node:net";
import { isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const defaultEnvironmentFile = fileURLToPath(
  new URL("../deploy/staging/staging.env", import.meta.url),
);

const PUBLIC_VARIABLES = [
  "COMPOSE_PROJECT_NAME",
  "ATOMS_IMAGE_TAG",
  "ATOMS_STAGING_SECRETS_DIR",
  "ATOMS_WEB_ORIGIN",
  "ATOMS_CONTROL_API_ORIGIN",
  "ATOMS_PREVIEW_BASE_DOMAIN",
  "ATOMS_WEB_PORT",
  "ATOMS_CONTROL_API_PORT",
  "ATOMS_PREVIEW_GATEWAY_PORT",
  "ATOMS_SUPABASE_URL",
  "ATOMS_SUPABASE_PUBLISHABLE_KEY",
  "ATOMS_AUTH_ISSUER_URL",
  "ATOMS_AUTH_AUDIENCE",
  "ATOMS_AUTH_JWKS_URL",
  "ATOMS_AUTH_ALLOWED_ALGORITHMS",
  "ATOMS_POSTGRES_DB",
  "ATOMS_POSTGRES_USER",
  "ATOMS_S3_BUCKET",
  "ATOMS_S3_REGION",
  "ATOMS_RUN_QUEUE_PREFIX",
  "ATOMS_ORCHESTRATOR_CONCURRENCY",
  "ATOMS_ATTACHMENT_SCAN_CONCURRENCY",
  "ATOMS_E2B_ALLOWED_HOSTS",
  "ATOMS_SUPABASE_MANAGEMENT_API_URL",
];

const SECRET_ENVIRONMENTS = {
  "migration.env": {
    required: ["DATABASE_URL"],
    optional: [],
  },
  "control-api.env": {
    required: [
      "DATABASE_URL",
      "REDIS_URL",
      "S3_ACCESS_KEY_ID",
      "S3_SECRET_ACCESS_KEY",
      "S3_KMS_KEY_ID",
    ],
    optional: [],
  },
  "worker.env": {
    required: [
      "DATABASE_URL",
      "REDIS_URL",
      "OPENAI_API_KEY",
      "E2B_API_KEY",
      "PREVIEW_SIGNING_SECRET",
      "S3_ACCESS_KEY_ID",
      "S3_SECRET_ACCESS_KEY",
      "S3_KMS_KEY_ID",
      "SUPABASE_ACCESS_TOKEN",
      "SUPABASE_ORGANIZATION_SLUG",
      "VAULT_ADDR",
      "VAULT_TOKEN",
    ],
    optional: ["VAULT_KV_MOUNT", "VAULT_NAMESPACE"],
  },
  "preview-gateway.env": {
    required: ["REDIS_URL", "PREVIEW_SIGNING_SECRET"],
    optional: [],
  },
};

const OPAQUE_SECRET_FILES = [
  "postgres-password",
  "redis-password",
  "minio-root-user",
  "minio-root-password",
  "s3-access-key-id",
  "s3-secret-access-key",
  "minio-kms-secret-key",
];

const ASYMMETRIC_JWT_ALGORITHMS = new Set([
  "RS256",
  "RS384",
  "RS512",
  "PS256",
  "PS384",
  "PS512",
  "ES256",
  "ES384",
  "ES512",
  "EdDSA",
]);

export async function validateStagingDeployment(options = {}) {
  const violations = [];
  const environmentFile = resolve(options.environmentFile ?? defaultEnvironmentFile);
  const publicEnvironment = await loadEnvironmentFile(
    environmentFile,
    "public deployment environment",
    false,
    violations,
  );

  rejectUnknownVariables(
    publicEnvironment,
    new Set(PUBLIC_VARIABLES),
    "public deployment environment",
    violations,
  );
  requireVariables(
    publicEnvironment,
    PUBLIC_VARIABLES,
    "public deployment environment",
    violations,
  );

  const configuredSecretsDirectory = publicEnvironment.ATOMS_STAGING_SECRETS_DIR;
  const secretsDirectory = resolve(
    options.secretsDirectory ?? configuredSecretsDirectory ?? ".",
  );
  if (configuredSecretsDirectory !== undefined) {
    if (!isAbsolute(configuredSecretsDirectory)) {
      violations.push("ATOMS_STAGING_SECRETS_DIR must be an absolute path");
    } else if (resolve(configuredSecretsDirectory) !== secretsDirectory) {
      violations.push(
        "the requested secrets directory must match ATOMS_STAGING_SECRETS_DIR",
      );
    }
  }

  if (isInsideRepository(secretsDirectory)) {
    violations.push("the staging secrets directory must be outside the repository");
  }
  await validateSecretDirectory(secretsDirectory, violations);

  const secretEnvironments = {};
  for (const [fileName, contract] of Object.entries(SECRET_ENVIRONMENTS)) {
    const environment = await loadEnvironmentFile(
      resolve(secretsDirectory, fileName),
      fileName,
      true,
      violations,
    );
    secretEnvironments[fileName] = environment;
    const allowed = new Set([...contract.required, ...contract.optional]);
    rejectUnknownVariables(environment, allowed, fileName, violations);
    requireVariables(environment, contract.required, fileName, violations);
  }

  const opaqueSecrets = {};
  for (const fileName of OPAQUE_SECRET_FILES) {
    opaqueSecrets[fileName] = await loadOpaqueSecret(
      resolve(secretsDirectory, fileName),
      fileName,
      violations,
    );
  }

  validatePublicEnvironment(publicEnvironment, violations);
  validateSecretContract(
    publicEnvironment,
    secretEnvironments,
    opaqueSecrets,
    violations,
  );

  return {
    ok: violations.length === 0,
    violations,
    checked: {
      publicEnvironmentFiles: 1,
      serviceEnvironmentFiles: Object.keys(SECRET_ENVIRONMENTS).length,
      opaqueSecretFiles: OPAQUE_SECRET_FILES.length,
    },
  };
}

async function loadEnvironmentFile(path, label, secret, violations) {
  const content = await loadFile(path, label, secret, violations);
  if (content === undefined) return {};
  return parseEnvironmentText(content, label, violations);
}

async function loadOpaqueSecret(path, label, violations) {
  const content = await loadFile(path, label, true, violations);
  if (content === undefined) return undefined;
  const withoutTerminalNewline = content.endsWith("\r\n")
    ? content.slice(0, -2)
    : content.endsWith("\n")
      ? content.slice(0, -1)
      : content;
  if (
    withoutTerminalNewline.length === 0 ||
    withoutTerminalNewline !== withoutTerminalNewline.trim() ||
    /[\0\r\n]/u.test(withoutTerminalNewline)
  ) {
    violations.push(`${label} must contain one non-empty single-line value`);
    return undefined;
  }
  return withoutTerminalNewline;
}

async function loadFile(path, label, secret, violations) {
  let metadata;
  try {
    metadata = await lstat(path);
  } catch {
    violations.push(`${label} is missing or unreadable`);
    return undefined;
  }
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    violations.push(`${label} must be a regular file, not a symlink`);
    return undefined;
  }
  if (secret && (metadata.mode & 0o077) !== 0) {
    violations.push(`${label} permissions must not grant group or other access`);
  }
  if (metadata.size > 65_536) {
    violations.push(`${label} exceeds the 64 KiB deployment limit`);
    return undefined;
  }
  try {
    return await readFile(path, "utf8");
  } catch {
    violations.push(`${label} is missing or unreadable`);
    return undefined;
  }
}

async function validateSecretDirectory(path, violations) {
  let metadata;
  try {
    metadata = await lstat(path);
  } catch {
    violations.push("the staging secrets directory is missing or unreadable");
    return;
  }
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    violations.push("the staging secrets directory must be a real directory");
    return;
  }
  if ((metadata.mode & 0o077) !== 0) {
    violations.push(
      "the staging secrets directory permissions must not grant group or other access",
    );
  }
  try {
    const canonicalPath = await realpath(path);
    if (isInsideRepository(canonicalPath)) {
      violations.push("the staging secrets directory must be outside the repository");
    }
  } catch {
    violations.push("the staging secrets directory is missing or unreadable");
  }
}

function parseEnvironmentText(content, label, violations) {
  const environment = {};
  const lines = content.replace(/^\uFEFF/u, "").split(/\r?\n/u);
  for (const [index, line] of lines.entries()) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator <= 0) {
      violations.push(`${label} line ${String(index + 1)} is not NAME=value`);
      continue;
    }
    const name = line.slice(0, separator).trim();
    const rawValue = line.slice(separator + 1);
    if (!/^[A-Z][A-Z0-9_]*$/u.test(name)) {
      violations.push(`${label} line ${String(index + 1)} has an invalid name`);
      continue;
    }
    if (Object.hasOwn(environment, name)) {
      violations.push(`${label} defines ${name} more than once`);
      continue;
    }
    if (
      rawValue.length === 0 ||
      rawValue !== rawValue.trim() ||
      /^['"]/u.test(rawValue) ||
      /[\s#]/u.test(rawValue) ||
      /[\0\r\n]/u.test(rawValue)
    ) {
      violations.push(`${label} variable ${name} must use one non-empty raw value`);
      continue;
    }
    environment[name] = rawValue;
  }
  return environment;
}

function rejectUnknownVariables(environment, allowed, label, violations) {
  for (const name of Object.keys(environment)) {
    if (!allowed.has(name)) {
      violations.push(`${label} contains unsupported variable ${name}`);
    }
  }
}

function requireVariables(environment, required, label, violations) {
  for (const name of required) {
    if (environment[name] === undefined) {
      violations.push(`${label} is missing ${name}`);
    }
  }
}

function validatePublicEnvironment(environment, violations) {
  if (!/^[a-z0-9][a-z0-9_-]{2,62}$/u.test(environment.COMPOSE_PROJECT_NAME ?? "")) {
    violations.push("COMPOSE_PROJECT_NAME must be a normalized deployment name");
  }
  if (!/^[a-f0-9]{40}$/u.test(environment.ATOMS_IMAGE_TAG ?? "")) {
    violations.push("ATOMS_IMAGE_TAG must be the full lowercase 40-character Git SHA");
  }

  const webOrigin = validateHttpsOrigin(
    environment.ATOMS_WEB_ORIGIN,
    "ATOMS_WEB_ORIGIN",
    violations,
  );
  const apiOrigin = validateHttpsOrigin(
    environment.ATOMS_CONTROL_API_ORIGIN,
    "ATOMS_CONTROL_API_ORIGIN",
    violations,
  );
  const supabaseOrigin = validateHttpsOrigin(
    environment.ATOMS_SUPABASE_URL,
    "ATOMS_SUPABASE_URL",
    violations,
  );
  const managementOrigin = validateHttpsOrigin(
    environment.ATOMS_SUPABASE_MANAGEMENT_API_URL,
    "ATOMS_SUPABASE_MANAGEMENT_API_URL",
    violations,
  );
  if (managementOrigin !== undefined && managementOrigin.pathname !== "/") {
    violations.push("ATOMS_SUPABASE_MANAGEMENT_API_URL must not contain a path");
  }

  const previewDomain = (environment.ATOMS_PREVIEW_BASE_DOMAIN ?? "").toLowerCase();
  if (
    !isHostname(previewDomain) ||
    previewDomain.startsWith("*.") ||
    isReservedHostname(previewDomain)
  ) {
    violations.push("ATOMS_PREVIEW_BASE_DOMAIN must be a real staging DNS name");
  }
  if (
    webOrigin !== undefined &&
    apiOrigin !== undefined &&
    webOrigin.hostname === apiOrigin.hostname
  ) {
    violations.push("the web and Control API must use different hostnames");
  }
  if (
    previewDomain.length > 0 &&
    [webOrigin?.hostname, apiOrigin?.hostname].includes(previewDomain)
  ) {
    violations.push("the wildcard preview base domain must be distinct from web and API");
  }

  const issuer = validateHttpsUrl(
    environment.ATOMS_AUTH_ISSUER_URL,
    "ATOMS_AUTH_ISSUER_URL",
    violations,
  );
  const jwks = validateHttpsUrl(
    environment.ATOMS_AUTH_JWKS_URL,
    "ATOMS_AUTH_JWKS_URL",
    violations,
  );
  if (issuer !== undefined && issuer.pathname.replace(/\/$/u, "") !== "/auth/v1") {
    violations.push("ATOMS_AUTH_ISSUER_URL must end with /auth/v1");
  }
  if (
    issuer !== undefined &&
    supabaseOrigin !== undefined &&
    issuer.origin !== supabaseOrigin.origin
  ) {
    violations.push("Supabase browser and auth issuer origins must match");
  }
  if (
    issuer !== undefined &&
    jwks !== undefined &&
    (jwks.origin !== issuer.origin ||
      jwks.pathname !==
        `${issuer.pathname.replace(/\/$/u, "")}/.well-known/jwks.json`)
  ) {
    violations.push("ATOMS_AUTH_JWKS_URL must be the issuer JWKS endpoint");
  }
  if (
    isPlaceholder(environment.ATOMS_SUPABASE_PUBLISHABLE_KEY) ||
    (environment.ATOMS_SUPABASE_PUBLISHABLE_KEY?.length ?? 0) < 20
  ) {
    violations.push("ATOMS_SUPABASE_PUBLISHABLE_KEY must be configured");
  }
  if (!/^[A-Za-z0-9._:/-]{1,191}$/u.test(environment.ATOMS_AUTH_AUDIENCE ?? "")) {
    violations.push("ATOMS_AUTH_AUDIENCE must be normalized");
  }
  const algorithms = (environment.ATOMS_AUTH_ALLOWED_ALGORITHMS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (
    algorithms.length === 0 ||
    algorithms.some((algorithm) => !ASYMMETRIC_JWT_ALGORITHMS.has(algorithm))
  ) {
    violations.push("ATOMS_AUTH_ALLOWED_ALGORITHMS must contain only asymmetric JWT algorithms");
  }

  const ports = [
    parsePort(environment.ATOMS_WEB_PORT, "ATOMS_WEB_PORT", violations),
    parsePort(
      environment.ATOMS_CONTROL_API_PORT,
      "ATOMS_CONTROL_API_PORT",
      violations,
    ),
    parsePort(
      environment.ATOMS_PREVIEW_GATEWAY_PORT,
      "ATOMS_PREVIEW_GATEWAY_PORT",
      violations,
    ),
  ].filter((port) => port !== undefined);
  if (new Set(ports).size !== ports.length) {
    violations.push("staging loopback ports must be distinct");
  }

  validateIdentifier(
    environment.ATOMS_POSTGRES_DB,
    "ATOMS_POSTGRES_DB",
    /^[a-z][a-z0-9_]{0,62}$/u,
    violations,
  );
  validateIdentifier(
    environment.ATOMS_POSTGRES_USER,
    "ATOMS_POSTGRES_USER",
    /^[a-z][a-z0-9_]{0,62}$/u,
    violations,
  );
  validateIdentifier(
    environment.ATOMS_S3_BUCKET,
    "ATOMS_S3_BUCKET",
    /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/u,
    violations,
  );
  validateIdentifier(
    environment.ATOMS_S3_REGION,
    "ATOMS_S3_REGION",
    /^[a-z0-9][a-z0-9-]{0,62}$/u,
    violations,
  );
  validateIdentifier(
    environment.ATOMS_RUN_QUEUE_PREFIX,
    "ATOMS_RUN_QUEUE_PREFIX",
    /^[A-Za-z0-9][A-Za-z0-9:_-]{0,62}$/u,
    violations,
  );
  parseBoundedInteger(
    environment.ATOMS_ORCHESTRATOR_CONCURRENCY,
    "ATOMS_ORCHESTRATOR_CONCURRENCY",
    1,
    32,
    violations,
  );
  parseBoundedInteger(
    environment.ATOMS_ATTACHMENT_SCAN_CONCURRENCY,
    "ATOMS_ATTACHMENT_SCAN_CONCURRENCY",
    1,
    16,
    violations,
  );
  const allowedHosts = (environment.ATOMS_E2B_ALLOWED_HOSTS ?? "")
    .split(",")
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean);
  if (
    allowedHosts.length === 0 ||
    allowedHosts.length > 20 ||
    allowedHosts.some((host) => !isHostname(host) || isReservedHostname(host))
  ) {
    violations.push("ATOMS_E2B_ALLOWED_HOSTS must contain valid public hostnames");
  }
}

function validateSecretContract(publicEnvironment, environments, secrets, violations) {
  const migration = environments["migration.env"] ?? {};
  const controlApi = environments["control-api.env"] ?? {};
  const worker = environments["worker.env"] ?? {};
  const previewGateway = environments["preview-gateway.env"] ?? {};

  compareValues(
    [migration.DATABASE_URL, controlApi.DATABASE_URL, worker.DATABASE_URL],
    "DATABASE_URL must match across migration, Control API, and worker",
    violations,
  );
  validateDatabaseUrl(
    migration.DATABASE_URL,
    publicEnvironment,
    secrets["postgres-password"],
    violations,
  );
  compareValues(
    [controlApi.REDIS_URL, worker.REDIS_URL, previewGateway.REDIS_URL],
    "REDIS_URL must match across Control API, worker, and preview gateway",
    violations,
  );
  validateRedisUrl(controlApi.REDIS_URL, secrets["redis-password"], violations);

  compareValues(
    [controlApi.S3_ACCESS_KEY_ID, worker.S3_ACCESS_KEY_ID, secrets["s3-access-key-id"]],
    "S3 access-key identifiers must match across services",
    violations,
  );
  compareValues(
    [
      controlApi.S3_SECRET_ACCESS_KEY,
      worker.S3_SECRET_ACCESS_KEY,
      secrets["s3-secret-access-key"],
    ],
    "S3 secret access keys must match across services",
    violations,
  );
  compareValues(
    [controlApi.S3_KMS_KEY_ID, worker.S3_KMS_KEY_ID],
    "S3 KMS key identifiers must match across services",
    violations,
  );
  compareValues(
    [worker.PREVIEW_SIGNING_SECRET, previewGateway.PREVIEW_SIGNING_SECRET],
    "preview signing secrets must match across worker and gateway",
    violations,
  );

  requireSecretLength(secrets["postgres-password"], 24, "postgres-password", violations);
  requireUrlSafeSecret(secrets["redis-password"], 24, "redis-password", violations);
  requireSecretLength(secrets["minio-root-user"], 3, "minio-root-user", violations);
  requireSecretLength(
    secrets["minio-root-password"],
    24,
    "minio-root-password",
    violations,
  );
  requireSecretLength(secrets["s3-access-key-id"], 3, "s3-access-key-id", violations);
  requireSecretLength(
    secrets["s3-secret-access-key"],
    24,
    "s3-secret-access-key",
    violations,
  );
  requireSecretLength(worker.OPENAI_API_KEY, 20, "OPENAI_API_KEY", violations);
  requireSecretLength(worker.E2B_API_KEY, 20, "E2B_API_KEY", violations);
  requireSecretLength(
    worker.PREVIEW_SIGNING_SECRET,
    32,
    "PREVIEW_SIGNING_SECRET",
    violations,
  );
  requireSecretLength(
    worker.SUPABASE_ACCESS_TOKEN,
    20,
    "SUPABASE_ACCESS_TOKEN",
    violations,
  );
  requireSecretLength(worker.VAULT_TOKEN, 20, "VAULT_TOKEN", violations);

  if (
    secrets["minio-root-user"] !== undefined &&
    secrets["minio-root-user"] === secrets["s3-access-key-id"]
  ) {
    violations.push("MinIO root and application access-key identities must differ");
  }
  if (
    secrets["minio-root-password"] !== undefined &&
    secrets["minio-root-password"] === secrets["s3-secret-access-key"]
  ) {
    violations.push("MinIO root and application secret keys must differ");
  }

  const kms = validateMinioKmsSecret(secrets["minio-kms-secret-key"], violations);
  if (
    kms !== undefined &&
    [controlApi.S3_KMS_KEY_ID, worker.S3_KMS_KEY_ID].some(
      (keyId) => keyId !== undefined && keyId !== kms.keyId,
    )
  ) {
    violations.push("S3_KMS_KEY_ID must match the MinIO KMS key identifier");
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{1,190}$/u.test(worker.SUPABASE_ORGANIZATION_SLUG ?? "")) {
    violations.push("SUPABASE_ORGANIZATION_SLUG must be normalized");
  }
  validateHttpsUrl(worker.VAULT_ADDR, "VAULT_ADDR", violations);
  for (const [name, value] of [
    ["OPENAI_API_KEY", worker.OPENAI_API_KEY],
    ["E2B_API_KEY", worker.E2B_API_KEY],
    ["SUPABASE_ACCESS_TOKEN", worker.SUPABASE_ACCESS_TOKEN],
    ["VAULT_TOKEN", worker.VAULT_TOKEN],
  ]) {
    if (isPlaceholder(value)) violations.push(`${name} must be configured`);
  }
}

function validateDatabaseUrl(value, publicEnvironment, password, violations) {
  const url = parseUrl(value, "DATABASE_URL", violations);
  if (url === undefined) return;
  let decodedUsername;
  let decodedPassword;
  let decodedDatabase;
  try {
    decodedUsername = decodeURIComponent(url.username);
    decodedPassword = decodeURIComponent(url.password);
    decodedDatabase = decodeURIComponent(url.pathname.replace(/^\//u, ""));
  } catch {
    violations.push("DATABASE_URL credentials must use valid percent encoding");
    return;
  }
  if (
    !["postgres:", "postgresql:"].includes(url.protocol) ||
    url.hostname !== "postgres" ||
    !["", "5432"].includes(url.port) ||
    decodedUsername !== publicEnvironment.ATOMS_POSTGRES_USER ||
    decodedDatabase !== publicEnvironment.ATOMS_POSTGRES_DB ||
    decodedPassword !== password
  ) {
    violations.push("DATABASE_URL must target the private staging PostgreSQL service");
  }
}

function validateRedisUrl(value, password, violations) {
  const url = parseUrl(value, "REDIS_URL", violations);
  if (url === undefined) return;
  let decodedPassword;
  try {
    decodedPassword = decodeURIComponent(url.password);
  } catch {
    violations.push("REDIS_URL credentials must use valid percent encoding");
    return;
  }
  if (
    url.protocol !== "redis:" ||
    url.hostname !== "redis" ||
    !["", "6379"].includes(url.port) ||
    decodedPassword !== password ||
    !["", "/"].includes(url.pathname)
  ) {
    violations.push("REDIS_URL must target the private password-protected Redis service");
  }
}

function validateMinioKmsSecret(value, violations) {
  if (value === undefined) return undefined;
  const separator = value.indexOf(":");
  const keyId = separator < 0 ? "" : value.slice(0, separator);
  const encodedKey = separator < 0 ? "" : value.slice(separator + 1);
  let decoded;
  try {
    decoded = Buffer.from(encodedKey, "base64");
  } catch {
    decoded = Buffer.alloc(0);
  }
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._-]{1,190}$/u.test(keyId) ||
    decoded.length !== 32 ||
    decoded.toString("base64") !== encodedKey
  ) {
    violations.push("minio-kms-secret-key must contain a key ID and 32-byte base64 key");
    return undefined;
  }
  return { keyId };
}

function validateHttpsOrigin(value, name, violations) {
  const url = validateHttpsUrl(value, name, violations);
  if (url === undefined) return undefined;
  if (!isHostname(url.hostname)) {
    violations.push(`${name} must use a DNS hostname`);
  }
  if (
    url.pathname !== "/" ||
    url.search.length > 0 ||
    url.hash.length > 0 ||
    url.username.length > 0 ||
    url.password.length > 0
  ) {
    violations.push(`${name} must be an HTTPS origin without credentials or a path`);
  }
  return url;
}

function validateHttpsUrl(value, name, violations) {
  const url = parseUrl(value, name, violations);
  if (url === undefined) return undefined;
  if (
    url.protocol !== "https:" ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.search.length > 0 ||
    url.hash.length > 0 ||
    isReservedHostname(url.hostname)
  ) {
    violations.push(`${name} must use a real HTTPS endpoint without credentials`);
  }
  return url;
}

function parseUrl(value, name, violations) {
  if (value === undefined) return undefined;
  try {
    return new URL(value);
  } catch {
    violations.push(`${name} must be a valid URL`);
    return undefined;
  }
}

function parsePort(value, name, violations) {
  return parseBoundedInteger(value, name, 1_024, 65_535, violations);
}

function parseBoundedInteger(value, name, minimum, maximum, violations) {
  if (!/^(?:0|[1-9]\d*)$/u.test(value ?? "")) {
    violations.push(`${name} must be an integer`);
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    violations.push(`${name} must be between ${String(minimum)} and ${String(maximum)}`);
    return undefined;
  }
  return parsed;
}

function validateIdentifier(value, name, pattern, violations) {
  if (!pattern.test(value ?? "")) violations.push(`${name} is not normalized`);
}

function compareValues(values, message, violations) {
  const configured = values.filter((value) => value !== undefined);
  if (configured.length > 1 && new Set(configured).size !== 1) violations.push(message);
}

function requireSecretLength(value, minimum, name, violations) {
  if (value !== undefined && value.length < minimum) {
    violations.push(`${name} must contain at least ${String(minimum)} characters`);
  }
}

function requireUrlSafeSecret(value, minimum, name, violations) {
  requireSecretLength(value, minimum, name, violations);
  if (value !== undefined && !/^[A-Za-z0-9._~-]+$/u.test(value)) {
    violations.push(`${name} must use URL-safe unquoted characters`);
  }
}

function isHostname(value) {
  if (value.length > 253 || !value.includes(".") || isIP(value) !== 0) return false;
  return value.split(".").every(
    (label) =>
      label.length > 0 &&
      label.length <= 63 &&
      /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(label),
  );
}

function isReservedHostname(hostname) {
  const normalized = hostname.toLowerCase().replace(/\.$/u, "");
  return (
    normalized === "localhost" ||
    normalized === "example.com" ||
    normalized.endsWith(".localhost") ||
    normalized.endsWith(".example") ||
    normalized.endsWith(".example.com") ||
    normalized.endsWith(".invalid") ||
    normalized.endsWith(".test")
  );
}

function isPlaceholder(value) {
  return (
    typeof value !== "string" ||
    /^(?:replace|change.?me|your[-_]|example)/iu.test(value) ||
    value.includes("your-project-ref")
  );
}

function isInsideRepository(path) {
  const pathFromRoot = relative(repositoryRoot, path);
  return (
    pathFromRoot === "" ||
    (!pathFromRoot.startsWith("..") && !isAbsolute(pathFromRoot))
  );
}

function parseArguments(arguments_) {
  const options = {};
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--env-file") {
      options.environmentFile = arguments_[index + 1];
      index += 1;
    } else if (argument === "--secrets-dir") {
      options.secretsDirectory = arguments_[index + 1];
      index += 1;
    } else {
      throw new Error(`Unknown staging preflight argument: ${argument}`);
    }
  }
  return options;
}

export async function main(arguments_ = process.argv.slice(2)) {
  let options;
  try {
    options = parseArguments(arguments_);
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Invalid staging preflight arguments");
    process.exitCode = 1;
    return { ok: false, violations: ["invalid arguments"] };
  }
  const result = await validateStagingDeployment(options);
  if (!result.ok) {
    console.error("Staging deployment preflight failed:");
    for (const violation of result.violations) console.error(`- ${violation}`);
    process.exitCode = 1;
    return result;
  }
  console.log(
    `Staging deployment preflight passed (${String(result.checked.serviceEnvironmentFiles)} service env files and ${String(result.checked.opaqueSecretFiles)} opaque secret files validated).`,
  );
  return result;
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) await main();
