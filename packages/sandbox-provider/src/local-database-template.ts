import { Template } from "@e2b/code-interpreter";

/**
 * G3 (docs/adr/production-execution-gate.md, issue #130): a local, ephemeral
 * PostgreSQL server baked into the validation template, so a CLIENT_PORTAL
 * acceptance run has something real to sign in and create data against. It
 * never leaves the sandbox and needs no outbound network at run time -- only
 * the template build does, same trade-off as viability-template.ts's browser
 * install.
 *
 * UNVERIFIED against a real E2B sandbox: live execution is off (the standing
 * cost rule), so this has offline structural tests only, the same posture as
 * G5's live egress probe and G7's real-Chromium check before their live
 * evidence existed.
 */

export const LOCAL_DATABASE_DIRECTORY = "/opt/atoms-acceptance-db";
export const LOCAL_DATABASE_DATA_DIRECTORY = `${LOCAL_DATABASE_DIRECTORY}/data`;
export const LOCAL_DATABASE_LOG_PATH = `${LOCAL_DATABASE_DIRECTORY}/server.log`;
/**
 * A stable symlink to whatever version-specific directory the apt package
 * actually installs (Debian ships PostgreSQL binaries under
 * /usr/lib/postgresql/<version>/bin, and the version depends on the base
 * image). Created once at build time so no command anywhere -- at build time
 * or at run time -- has to glob-match a version number.
 */
export const LOCAL_DATABASE_BIN_DIRECTORY = `${LOCAL_DATABASE_DIRECTORY}/bin`;
export const LOCAL_DATABASE_PORT = 5433; // distinct from Postgres's default 5432, so it can never collide with a generated app's own expectations
export const LOCAL_DATABASE_NAME = "acceptance";
export const LOCAL_DATABASE_USER = "acceptance";
/** Sandbox-local only; the database exists for the lifetime of one ephemeral sandbox and is reachable only from inside it. Not a real secret. */
export const LOCAL_DATABASE_PASSWORD = "acceptance-local-only";
export const LOCAL_DATABASE_URL =
  `postgresql://${LOCAL_DATABASE_USER}:${LOCAL_DATABASE_PASSWORD}` +
  `@127.0.0.1:${String(LOCAL_DATABASE_PORT)}/${LOCAL_DATABASE_NAME}`;

/** Pinned so a template rebuild cannot silently change the server. */
export const LOCAL_DATABASE_APT_PACKAGE = "postgresql";

/**
 * Layers on `baseTemplate` (normally the viability template, itself layered on
 * the base validation template) rather than replacing it. `initdb` and the
 * role/database creation happen at build time so a run only has to start an
 * already-initialized server, not provision one from scratch.
 */
export function buildLocalDatabaseTemplate(baseTemplate: string) {
  if (baseTemplate.trim().length === 0) {
    throw new RangeError("a base template name is required");
  }
  const bin = LOCAL_DATABASE_BIN_DIRECTORY;
  const data = LOCAL_DATABASE_DATA_DIRECTORY;
  const port = String(LOCAL_DATABASE_PORT);
  return Template()
    .fromTemplate(baseTemplate)
    .runCmd(
      [
        "apt-get update",
        `apt-get install -y --no-install-recommends ${LOCAL_DATABASE_APT_PACKAGE}`,
        `mkdir -p ${data}`,
        // Resolve whatever version-specific bin directory apt actually installed
        // and pin it behind one stable path (see LOCAL_DATABASE_BIN_DIRECTORY).
        `ln -s "$(dirname "$(find /usr/lib/postgresql -maxdepth 3 -name pg_ctl | head -n1)")" ${bin}`,
        `chown -R postgres:postgres ${LOCAL_DATABASE_DIRECTORY}`,
        `su postgres -c "${bin}/initdb -D ${data}"`,
        `su postgres -c "${bin}/pg_ctl -D ${data} -o '-p ${port} -k /tmp' -l ${LOCAL_DATABASE_LOG_PATH} -w start"`,
        `su postgres -c "${bin}/psql -p ${port} -h /tmp -c \\"CREATE ROLE ${LOCAL_DATABASE_USER} LOGIN PASSWORD '${LOCAL_DATABASE_PASSWORD}';\\""`,
        `su postgres -c "${bin}/psql -p ${port} -h /tmp -c \\"CREATE DATABASE ${LOCAL_DATABASE_NAME} OWNER ${LOCAL_DATABASE_USER};\\""`,
        `su postgres -c "${bin}/pg_ctl -D ${data} -w stop"`,
        // The running sandbox user (not root, not postgres) only ever starts an
        // already-initialized server (see project-validation-runner.ts's db-start
        // step); it must be able to read and write the data directory to do that.
        `chown -R user:user ${LOCAL_DATABASE_DIRECTORY}`,
      ],
      { user: "root" },
    );
}

/** The steps the build would run, in the form the E2B API receives. Nothing is sent. */
export async function describeLocalDatabaseTemplate(
  baseTemplate: string,
): Promise<{ readonly fromTemplate: string; readonly stepTypes: readonly string[] }> {
  const parsed = JSON.parse(
    await Template.toJSON(buildLocalDatabaseTemplate(baseTemplate), false),
  ) as { fromTemplate: string; steps: Array<{ type: string }> };
  return {
    fromTemplate: parsed.fromTemplate,
    stepTypes: parsed.steps.map((step) => step.type),
  };
}

/** Builds and registers the template on E2B. Billable and needs network. */
export async function buildLocalDatabaseTemplateOnE2B(options: {
  readonly baseTemplate: string;
  readonly name: string;
  readonly apiKey: string;
  readonly onLog?: (line: string) => void;
}): Promise<{ readonly name: string; readonly templateId: string }> {
  const info = await Template.build(buildLocalDatabaseTemplate(options.baseTemplate), {
    alias: options.name,
    apiKey: options.apiKey,
    cpuCount: 2,
    memoryMB: 4096,
    ...(options.onLog === undefined
      ? {}
      : { onBuildLogs: (entry: { toString(): string }) => options.onLog?.(entry.toString()) }),
  });
  return { name: info.name ?? options.name, templateId: info.templateId };
}
