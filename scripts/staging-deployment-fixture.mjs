import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export async function createStagingDeploymentFixture(options = {}) {
  const root = await mkdtemp(join(tmpdir(), "atoms-staging-deployment-"));
  const secretsDirectory = join(root, "secrets");
  await mkdir(secretsDirectory, { mode: 0o700 });
  await chmod(secretsDirectory, 0o700);

  const values = {
    databasePassword: "database-passphrase-0123456789abcdef",
    redisPassword: "redis-passphrase-0123456789abcdef",
    minioRootUser: "atoms-root-fixture",
    minioRootPassword: "minio-root-passphrase-0123456789abcdef",
    s3AccessKeyId: "atoms-app-fixture",
    s3SecretAccessKey: "minio-app-passphrase-0123456789abcdef",
    kmsKeyId: "atoms-staging-kms",
    previewSigningSecret: "preview-signing-secret-0123456789abcdef",
    openAiCredential: "configured-openai-credential-0123456789abcdef",
    e2bCredential: "configured-e2b-credential-0123456789abcdef",
    supabaseCredential: "configured-supabase-credential-0123456789abcdef",
    vaultCredential: "configured-vault-credential-0123456789abcdef",
    smokePrimaryPassword: "primary-smoke-password-0123456789abcdef",
    smokeForeignPassword: "foreign-smoke-password-0123456789abcdef",
  };
  values.databaseUrl = `postgresql://atoms:${encodeURIComponent(values.databasePassword)}@postgres:5432/atoms?schema=public`;
  values.redisUrl = `redis://:${encodeURIComponent(values.redisPassword)}@redis:6379`;
  values.kmsSecret = `${values.kmsKeyId}:${Buffer.from("0123456789abcdef0123456789abcdef").toString("base64")}`;

  const environmentFile = join(root, "staging.env");
  await writeFile(
    environmentFile,
    environmentText({
      COMPOSE_PROJECT_NAME: "atoms-staging",
      ATOMS_IMAGE_TAG: "a".repeat(40),
      ATOMS_STAGING_SECRETS_DIR: secretsDirectory,
      ATOMS_WEB_ORIGIN: "https://app.staging.atoms.dev",
      ATOMS_CONTROL_API_ORIGIN: "https://api.staging.atoms.dev",
      ATOMS_STORAGE_ORIGIN: "https://storage.staging.atoms.dev",
      ATOMS_PREVIEW_BASE_DOMAIN: "preview.staging.atoms.dev",
      ATOMS_SUPABASE_URL: "https://fixture-project.supabase.co",
      ATOMS_SUPABASE_PUBLISHABLE_KEY:
        "sb_publishable_fixture_0123456789abcdef",
      ATOMS_AUTH_ISSUER_URL:
        "https://fixture-project.supabase.co/auth/v1",
      ATOMS_AUTH_AUDIENCE: "authenticated",
      ATOMS_AUTH_JWKS_URL:
        "https://fixture-project.supabase.co/auth/v1/.well-known/jwks.json",
      ATOMS_AUTH_ALLOWED_ALGORITHMS: "ES256",
      ATOMS_POSTGRES_DB: "atoms",
      ATOMS_POSTGRES_USER: "atoms",
      ATOMS_S3_BUCKET: "atoms-attachments",
      ATOMS_S3_REGION: "us-east-1",
      ATOMS_RUN_QUEUE_PREFIX: "atoms-staging",
      ATOMS_ORCHESTRATOR_CONCURRENCY: "2",
      ATOMS_ATTACHMENT_SCAN_CONCURRENCY: "2",
      ATOMS_E2B_ALLOWED_HOSTS: "registry.npmjs.org,binaries.prisma.sh",
      ATOMS_SUPABASE_MANAGEMENT_API_URL: "https://api.supabase.com",
    }),
    { mode: 0o644 },
  );

  await writeSecureEnvironment(secretsDirectory, "migration.env", {
    DATABASE_URL: values.databaseUrl,
  });
  await writeSecureEnvironment(secretsDirectory, "control-api.env", {
    DATABASE_URL: values.databaseUrl,
    REDIS_URL: values.redisUrl,
    S3_ACCESS_KEY_ID: values.s3AccessKeyId,
    S3_SECRET_ACCESS_KEY: values.s3SecretAccessKey,
    S3_KMS_KEY_ID: values.kmsKeyId,
  });
  await writeSecureEnvironment(secretsDirectory, "worker.env", {
    DATABASE_URL: values.databaseUrl,
    REDIS_URL: values.redisUrl,
    OPENAI_API_KEY: values.openAiCredential,
    E2B_API_KEY: values.e2bCredential,
    PREVIEW_SIGNING_SECRET: values.previewSigningSecret,
    S3_ACCESS_KEY_ID: values.s3AccessKeyId,
    S3_SECRET_ACCESS_KEY: values.s3SecretAccessKey,
    S3_KMS_KEY_ID: values.kmsKeyId,
    SUPABASE_ACCESS_TOKEN: values.supabaseCredential,
    SUPABASE_ORGANIZATION_SLUG: "fixture-organization",
    VAULT_ADDR: "https://vault.staging.atoms.internal",
    VAULT_TOKEN: values.vaultCredential,
  });
  await writeSecureEnvironment(secretsDirectory, "preview-gateway.env", {
    REDIS_URL: values.redisUrl,
    PREVIEW_SIGNING_SECRET: values.previewSigningSecret,
  });
  await writeSecureEnvironment(secretsDirectory, "authenticated-smoke.env", {
    ATOMS_SMOKE_PRIMARY_EMAIL: "primary-smoke@staging.atoms.dev",
    ATOMS_SMOKE_PRIMARY_PASSWORD: values.smokePrimaryPassword,
    ATOMS_SMOKE_FOREIGN_EMAIL: "foreign-smoke@staging.atoms.dev",
    ATOMS_SMOKE_FOREIGN_PASSWORD: values.smokeForeignPassword,
    ATOMS_SMOKE_FOREIGN_PROJECT_ID: "00000000-0000-4000-8000-000000000099",
  });

  await Promise.all([
    writeSecureFile(secretsDirectory, "postgres-password", values.databasePassword),
    writeSecureFile(secretsDirectory, "redis-password", values.redisPassword),
    writeSecureFile(secretsDirectory, "minio-root-user", values.minioRootUser),
    writeSecureFile(
      secretsDirectory,
      "minio-root-password",
      values.minioRootPassword,
    ),
    writeSecureFile(secretsDirectory, "s3-access-key-id", values.s3AccessKeyId),
    writeSecureFile(
      secretsDirectory,
      "s3-secret-access-key",
      values.s3SecretAccessKey,
    ),
    writeSecureFile(secretsDirectory, "minio-kms-secret-key", values.kmsSecret),
  ]);
  await writeTlsMaterial(
    secretsDirectory,
    options.tlsDnsNames ?? [
      "app.staging.atoms.dev",
      "api.staging.atoms.dev",
      "storage.staging.atoms.dev",
      "*.preview.staging.atoms.dev",
    ],
    options.tlsDays ?? 30,
  );

  return {
    root,
    environmentFile,
    secretsDirectory,
    values,
    async cleanup() {
      await rm(root, { recursive: true, force: true });
    },
  };
}

async function writeTlsMaterial(directory, dnsNames, days) {
  const certificatePath = join(directory, "tls-certificate.pem");
  const privateKeyPath = join(directory, "tls-private-key.pem");
  const result = spawnSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-sha256",
      "-nodes",
      "-days",
      String(days),
      "-subj",
      `/CN=${dnsNames[0]}`,
      "-addext",
      `subjectAltName=${dnsNames.map((name) => `DNS:${name}`).join(",")}`,
      "-keyout",
      privateKeyPath,
      "-out",
      certificatePath,
    ],
    { encoding: "utf8" },
  );
  if (result.error !== undefined || result.status !== 0) {
    throw new Error("OpenSSL could not create the isolated staging TLS fixture");
  }
  await Promise.all([chmod(certificatePath, 0o444), chmod(privateKeyPath, 0o444)]);
}

export function environmentText(environment) {
  return `${Object.entries(environment)
    .map(([name, value]) => `${name}=${value}`)
    .join("\n")}\n`;
}

async function writeSecureEnvironment(directory, fileName, environment) {
  await writeSecureFile(directory, fileName, environmentText(environment));
}

async function writeSecureFile(directory, fileName, content) {
  const path = join(directory, fileName);
  await writeFile(path, content, { mode: 0o600 });
  await chmod(path, 0o444);
}
