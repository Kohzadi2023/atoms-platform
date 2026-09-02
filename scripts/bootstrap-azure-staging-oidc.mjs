import { spawnSync } from "node:child_process";
import { access, mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { isIP } from "node:net";
import { pathToFileURL } from "node:url";

export const AZURE_OIDC_PLAN_CONFIRMATION =
  "PLAN_DEDICATED_ATOMS_AZURE_OIDC";
export const AZURE_OIDC_APPLY_CONFIRMATION =
  "BOOTSTRAP_DEDICATED_ATOMS_AZURE_OIDC_WITHOUT_COMPUTE";

export const AZURE_STAGING_BOUNDARY = Object.freeze({
  repository: "Kohzadi2023/atoms-platform",
  repositoryId: "1319803321",
  ownerId: "149624604",
  environment: "phase3-staging",
  resourceGroup: "atoms-staging-rg",
  location: "canadacentral",
  applicationDisplayName: "atoms-platform-phase3-staging-oidc",
  federatedCredentialName: "github-atoms-phase3-staging-immutable",
});

export const AZURE_STAGING_ROLES = Object.freeze([
  Object.freeze({
    name: "Contributor",
    id: "b24988ac-6180-42a0-ab88-20f7382dd24c",
  }),
  Object.freeze({
    name: "Locks Contributor",
    id: "28bf596f-4eb7-45ce-b5bc-6cf482fec137",
  }),
  Object.freeze({
    name: "Cost Management Contributor",
    id: "434105ed-43f6-45c7-a02f-909b2ba83430",
  }),
]);

export const AZURE_STAGING_SECRET_NAMES = Object.freeze([
  "AZURE_CLIENT_ID",
  "AZURE_TENANT_ID",
  "AZURE_SUBSCRIPTION_ID",
  "AZURE_STAGING_SSH_PUBLIC_KEY",
  "AZURE_STAGING_SSH_SOURCE_CIDR",
  "AZURE_BUDGET_CONTACT_EMAIL",
]);

const EXPECTED_CONFIRMATIONS = new Map([
  ["plan", AZURE_OIDC_PLAN_CONFIRMATION],
  ["apply", AZURE_OIDC_APPLY_CONFIRMATION],
]);

const defaultDependencies = {
  run: runProcess,
  log: (message) => console.log(message),
};

function normalized(value) {
  if (typeof value !== "string") return undefined;
  const result = value.trim();
  return result.length === 0 ? undefined : result;
}

function isUuid(value) {
  if (value === undefined) return false;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(
    value,
  );
}

function isEmail(value) {
  if (value === undefined || value.length > 254) return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(value);
}

function isNarrowIpv4Cidr(value) {
  if (value === undefined) return false;
  const [address, prefix, ...rest] = value.split("/");
  if (rest.length > 0 || isIP(address) !== 4 || !/^\d{1,2}$/u.test(prefix ?? "")) {
    return false;
  }
  const prefixLength = Number(prefix);
  return prefixLength >= 24 && prefixLength <= 32;
}

function isSshPublicKey(value) {
  if (value === undefined || value.length > 16_384) return false;
  return /^ssh-(?:ed25519|rsa) [A-Za-z0-9+/]{32,}={0,3}(?: [^\r\n]+)?$/u.test(
    value,
  );
}

export function buildImmutableSubject(boundary = AZURE_STAGING_BOUNDARY) {
  return `repo:${boundary.repository.split("/")[0]}@${boundary.ownerId}/${
    boundary.repository.split("/")[1]
  }@${boundary.repositoryId}:environment:${boundary.environment}`;
}

export function buildResourceGroupScope(subscriptionId) {
  if (!isUuid(subscriptionId)) throw new Error("Subscription ID must be a UUID");
  return `/subscriptions/${subscriptionId}/resourceGroups/${AZURE_STAGING_BOUNDARY.resourceGroup}`;
}

export function parseAzureOidcBootstrapArguments(arguments_) {
  const normalizedArguments = arguments_[0] === "--" ? arguments_.slice(1) : arguments_;
  const optionNames = new Map([
    ["--mode", "mode"],
    ["--subscription-id", "subscriptionId"],
    ["--budget-email", "budgetEmail"],
    ["--ssh-source-cidr", "sshSourceCidr"],
    ["--ssh-key-path", "sshKeyPath"],
    ["--confirmation", "confirmation"],
  ]);
  const options = {
    mode: "plan",
    sshKeyPath: join(homedir(), ".ssh", "atoms-staging-azure"),
  };
  const supplied = new Set();

  for (let index = 0; index < normalizedArguments.length; index += 1) {
    const argument = normalizedArguments[index];
    const property = optionNames.get(argument);
    if (property === undefined) {
      throw new Error(`Unknown Azure OIDC bootstrap argument: ${argument}`);
    }
    if (supplied.has(property)) {
      throw new Error(`${argument} may be supplied only once`);
    }
    const value = normalizedArguments[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`${argument} requires a value`);
    }
    options[property] = value;
    supplied.add(property);
    index += 1;
  }

  options.sshKeyPath = resolve(options.sshKeyPath);
  const validation = validateAzureOidcBootstrapOptions(options);
  if (!validation.ok) {
    throw new Error(
      `Azure OIDC bootstrap command is invalid:\n${validation.violations
        .map((violation) => `- ${violation}`)
        .join("\n")}`,
    );
  }
  return options;
}

export function validateAzureOidcBootstrapOptions(options) {
  const violations = [];
  const expectedConfirmation = EXPECTED_CONFIRMATIONS.get(options.mode);

  if (expectedConfirmation === undefined) {
    violations.push("--mode must be plan or apply");
  } else if (options.confirmation !== expectedConfirmation) {
    violations.push(`--confirmation must exactly match the ${options.mode} acknowledgement`);
  }
  if (!isUuid(normalized(options.subscriptionId))) {
    violations.push("--subscription-id must be an explicit UUID");
  }
  if (!isEmail(normalized(options.budgetEmail))) {
    violations.push("--budget-email must be a valid notification address");
  }
  if (!isNarrowIpv4Cidr(normalized(options.sshSourceCidr))) {
    violations.push("--ssh-source-cidr must be one IPv4 CIDR between /24 and /32");
  }
  if (
    typeof options.sshKeyPath !== "string" ||
    !isAbsolute(options.sshKeyPath) ||
    options.sshKeyPath.endsWith(".pub")
  ) {
    violations.push("--ssh-key-path must be an absolute private-key path without .pub");
  }

  return { ok: violations.length === 0, violations };
}

export function buildRoleAssignmentArguments({ principalId, roleId, scope }) {
  if (!isUuid(principalId) || !isUuid(roleId)) {
    throw new Error("Azure role assignment identifiers must be UUIDs");
  }
  if (!scope.endsWith(`/resourceGroups/${AZURE_STAGING_BOUNDARY.resourceGroup}`)) {
    throw new Error("Azure role assignments must be scoped to atoms-staging-rg");
  }
  return [
    "role",
    "assignment",
    "create",
    "--assignee-object-id",
    principalId,
    "--assignee-principal-type",
    "ServicePrincipal",
    "--role",
    roleId,
    "--scope",
    scope,
    "--output",
    "none",
  ];
}

export function buildGitHubImmutableOidcArguments() {
  return [
    "api",
    "--method",
    "PUT",
    "-H",
    "X-GitHub-Api-Version: 2026-03-10",
    `repos/${AZURE_STAGING_BOUNDARY.repository}/actions/oidc/customization/sub`,
    "-F",
    "use_default=true",
    "-F",
    "use_immutable_subject=true",
  ];
}

export function buildGitHubSecretArguments(name) {
  if (!AZURE_STAGING_SECRET_NAMES.includes(name)) {
    throw new Error("Unexpected GitHub Environment secret name");
  }
  return [
    "secret",
    "set",
    name,
    "--repo",
    AZURE_STAGING_BOUNDARY.repository,
    "--env",
    AZURE_STAGING_BOUNDARY.environment,
    "--app",
    "actions",
  ];
}

function parseJson(output, context) {
  try {
    return JSON.parse(output);
  } catch {
    throw new Error(`${context} returned invalid JSON`);
  }
}

function runJson(dependencies, command, arguments_, context) {
  return parseJson(dependencies.run(command, arguments_), context);
}

function validateGitHubRepository(repository) {
  if (
    String(repository.id) !== AZURE_STAGING_BOUNDARY.repositoryId ||
    String(repository.owner?.id) !== AZURE_STAGING_BOUNDARY.ownerId ||
    repository.full_name !== AZURE_STAGING_BOUNDARY.repository
  ) {
    throw new Error("GitHub repository identity does not match the pinned immutable boundary");
  }
}

function validateAzureAccount(account, subscriptionId) {
  if (
    account.id?.toLowerCase() !== subscriptionId.toLowerCase() ||
    account.state !== "Enabled" ||
    !isUuid(account.tenantId)
  ) {
    throw new Error("Azure account does not match the enabled, explicitly selected subscription");
  }
}

function validateExistingResourceGroup(resourceGroup) {
  const managedBy = resourceGroup.tags?.managedBy;
  if (
    resourceGroup.name?.toLowerCase() !==
      AZURE_STAGING_BOUNDARY.resourceGroup.toLowerCase() ||
    resourceGroup.location?.toLowerCase() !== AZURE_STAGING_BOUNDARY.location ||
    resourceGroup.tags?.application !== "atoms-platform" ||
    resourceGroup.tags?.environment !== "staging" ||
    resourceGroup.tags?.repository !== AZURE_STAGING_BOUNDARY.repository ||
    !["oidc-bootstrap", "bicep"].includes(managedBy)
  ) {
    throw new Error("Existing atoms-staging-rg is outside the pinned ownership boundary");
  }
}

async function readOrCreateSshPublicKey(options, dependencies) {
  const publicKeyPath = `${options.sshKeyPath}.pub`;
  let privateKeyExists = true;
  let publicKeyExists = true;
  try {
    await access(options.sshKeyPath);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    privateKeyExists = false;
  }
  try {
    await readFile(publicKeyPath);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    publicKeyExists = false;
  }

  if (privateKeyExists !== publicKeyExists) {
    throw new Error("The dedicated SSH key pair is incomplete; no file was changed");
  }
  if (!privateKeyExists) {
    if (options.mode !== "apply") return undefined;
    await mkdir(dirname(options.sshKeyPath), { recursive: true, mode: 0o700 });
    dependencies.run("ssh-keygen", [
      "-q",
      "-t",
      "ed25519",
      "-f",
      options.sshKeyPath,
      "-N",
      "",
      "-C",
      "atoms-staging-azure",
    ]);
    dependencies.log("Created a dedicated local Ed25519 key pair; only its public key is uploaded.");
  }

  const publicKey = normalized(await readFile(publicKeyPath, "utf8"));
  if (!isSshPublicKey(publicKey)) {
    throw new Error("The dedicated SSH public key is invalid");
  }
  return publicKey;
}

function getExistingApplication(dependencies) {
  const applications = runJson(
    dependencies,
    "az",
    [
      "ad",
      "app",
      "list",
      "--display-name",
      AZURE_STAGING_BOUNDARY.applicationDisplayName,
      "--output",
      "json",
    ],
    "Azure application lookup",
  ).filter((application) => application.displayName === AZURE_STAGING_BOUNDARY.applicationDisplayName);
  if (applications.length > 1) {
    throw new Error("Multiple Azure applications share the dedicated staging name");
  }
  return applications[0];
}

function getExistingServicePrincipal(dependencies, applicationId) {
  const principals = runJson(
    dependencies,
    "az",
    ["ad", "sp", "list", "--filter", `appId eq '${applicationId}'`, "--output", "json"],
    "Azure service-principal lookup",
  );
  if (principals.length > 1) {
    throw new Error("Multiple service principals match the dedicated staging application");
  }
  return principals[0];
}

function validateApplication(application) {
  if (
    application.displayName !== AZURE_STAGING_BOUNDARY.applicationDisplayName ||
    application.signInAudience !== "AzureADMyOrg" ||
    !isUuid(application.id) ||
    !isUuid(application.appId)
  ) {
    throw new Error("Existing Azure application is outside the pinned OIDC boundary");
  }
}

function validateFederatedCredential(credential) {
  const issuer = credential.issuer?.replace(/\/$/u, "");
  if (
    credential.name !== AZURE_STAGING_BOUNDARY.federatedCredentialName ||
    issuer !== "https://token.actions.githubusercontent.com" ||
    credential.subject !== buildImmutableSubject() ||
    !Array.isArray(credential.audiences) ||
    credential.audiences.length !== 1 ||
    credential.audiences[0] !== "api://AzureADTokenExchange"
  ) {
    throw new Error("Existing federated credential does not match the immutable GitHub boundary");
  }
}

function configureGitHubSecrets(dependencies, values) {
  for (const name of AZURE_STAGING_SECRET_NAMES) {
    dependencies.run("gh", buildGitHubSecretArguments(name), {
      input: `${values[name]}\n`,
    });
    dependencies.log(`Configured GitHub Environment secret: ${name}`);
  }

  const configured = runJson(
    dependencies,
    "gh",
    [
      "secret",
      "list",
      "--repo",
      AZURE_STAGING_BOUNDARY.repository,
      "--env",
      AZURE_STAGING_BOUNDARY.environment,
      "--app",
      "actions",
      "--json",
      "name",
    ],
    "GitHub Environment secret verification",
  );
  const names = new Set(configured.map((secret) => secret.name));
  const missing = AZURE_STAGING_SECRET_NAMES.filter((name) => !names.has(name));
  if (missing.length > 0) {
    throw new Error(`GitHub Environment secret verification failed: ${missing.join(", ")}`);
  }
}

export async function bootstrapAzureStagingOidc(
  options,
  dependencies = defaultDependencies,
) {
  const validation = validateAzureOidcBootstrapOptions(options);
  if (!validation.ok) {
    throw new Error(validation.violations.join("; "));
  }

  dependencies.run("az", ["account", "set", "--subscription", options.subscriptionId]);
  const account = runJson(
    dependencies,
    "az",
    ["account", "show", "--output", "json"],
    "Azure account lookup",
  );
  validateAzureAccount(account, options.subscriptionId);
  dependencies.run("gh", ["auth", "status", "--hostname", "github.com"]);
  const repository = runJson(
    dependencies,
    "gh",
    ["api", `repos/${AZURE_STAGING_BOUNDARY.repository}`],
    "GitHub repository lookup",
  );
  validateGitHubRepository(repository);

  const scope = buildResourceGroupScope(options.subscriptionId);
  const publicKey = await readOrCreateSshPublicKey(options, dependencies);
  const groupExists =
    dependencies
      .run("az", [
        "group",
        "exists",
        "--name",
        AZURE_STAGING_BOUNDARY.resourceGroup,
        "--output",
        "tsv",
      ])
      .toLowerCase() === "true";
  if (groupExists) {
    validateExistingResourceGroup(
      runJson(
        dependencies,
        "az",
        ["group", "show", "--name", AZURE_STAGING_BOUNDARY.resourceGroup, "--output", "json"],
        "Azure resource-group lookup",
      ),
    );
  }

  const existingApplication = getExistingApplication(dependencies);
  if (existingApplication !== undefined) validateApplication(existingApplication);

  const oidcConfigurationBefore = runJson(
    dependencies,
    "gh",
    ["api", `repos/${AZURE_STAGING_BOUNDARY.repository}/actions/oidc/customization/sub`],
    "GitHub OIDC configuration lookup",
  );
  if (oidcConfigurationBefore.use_default !== true) {
    throw new Error("GitHub has a custom OIDC subject template; refusing to replace it");
  }
  runJson(
    dependencies,
    "gh",
    [
      "secret",
      "list",
      "--repo",
      AZURE_STAGING_BOUNDARY.repository,
      "--env",
      AZURE_STAGING_BOUNDARY.environment,
      "--app",
      "actions",
      "--json",
      "name",
    ],
    "GitHub Environment secret lookup",
  );

  if (options.mode === "plan") {
    if (existingApplication !== undefined) {
      const existingPrincipal = getExistingServicePrincipal(
        dependencies,
        existingApplication.appId,
      );
      if (existingPrincipal !== undefined) {
        if (!isUuid(existingPrincipal.id) || existingPrincipal.appId !== existingApplication.appId) {
          throw new Error("Azure service principal does not match the dedicated application");
        }
        const credentials = runJson(
          dependencies,
          "az",
          [
            "ad",
            "app",
            "federated-credential",
            "list",
            "--id",
            existingApplication.id,
            "--output",
            "json",
          ],
          "Azure federated-credential lookup",
        );
        const matchingCredential = credentials.filter(
          (credential) =>
            credential.name === AZURE_STAGING_BOUNDARY.federatedCredentialName,
        );
        if (matchingCredential.length > 1) {
          throw new Error("Multiple immutable federated credentials share the dedicated name");
        }
        if (matchingCredential.length === 1) {
          validateFederatedCredential(matchingCredential[0]);
        }
        if (groupExists) {
          runJson(
            dependencies,
            "az",
            [
              "role",
              "assignment",
              "list",
              "--assignee",
              existingPrincipal.id,
              "--scope",
              scope,
              "--output",
              "json",
            ],
            "Azure role-assignment lookup",
          );
        }
      }
    }
    dependencies.log("Azure OIDC bootstrap plan passed; no Azure or GitHub state was changed.");
    dependencies.log(`Target scope: ${AZURE_STAGING_BOUNDARY.resourceGroup} only.`);
    dependencies.log("Next safe action: rerun with --mode apply and the independent acknowledgement.");
    return { mode: options.mode, scope, changed: false };
  }

  if (!groupExists) {
    dependencies.run("az", [
      "group",
      "create",
      "--name",
      AZURE_STAGING_BOUNDARY.resourceGroup,
      "--location",
      AZURE_STAGING_BOUNDARY.location,
      "--tags",
      "application=atoms-platform",
      "environment=staging",
      "managedBy=oidc-bootstrap",
      `repository=${AZURE_STAGING_BOUNDARY.repository}`,
      "--output",
      "none",
    ]);
    dependencies.log("Created the empty, non-compute atoms-staging-rg control-plane boundary.");
  }

  let application = existingApplication;
  if (application === undefined) {
    application = runJson(
      dependencies,
      "az",
      [
        "ad",
        "app",
        "create",
        "--display-name",
        AZURE_STAGING_BOUNDARY.applicationDisplayName,
        "--sign-in-audience",
        "AzureADMyOrg",
        "--output",
        "json",
      ],
      "Azure application creation",
    );
    validateApplication(application);
    dependencies.log("Created the dedicated Microsoft Entra application without a client secret.");
  }

  let servicePrincipal = getExistingServicePrincipal(dependencies, application.appId);
  if (servicePrincipal === undefined) {
    servicePrincipal = runJson(
      dependencies,
      "az",
      ["ad", "sp", "create", "--id", application.appId, "--output", "json"],
      "Azure service-principal creation",
    );
    dependencies.log("Created the dedicated service principal without a password or certificate.");
  }
  if (!isUuid(servicePrincipal.id) || servicePrincipal.appId !== application.appId) {
    throw new Error("Azure service principal does not match the dedicated application");
  }

  const credentials = runJson(
    dependencies,
    "az",
    ["ad", "app", "federated-credential", "list", "--id", application.id, "--output", "json"],
    "Azure federated-credential lookup",
  );
  const matchingCredentials = credentials.filter(
    (credential) => credential.name === AZURE_STAGING_BOUNDARY.federatedCredentialName,
  );
  if (matchingCredentials.length > 1) {
    throw new Error("Multiple immutable federated credentials share the dedicated name");
  }
  if (matchingCredentials.length === 1) {
    validateFederatedCredential(matchingCredentials[0]);
  } else {
    const credential = {
      name: AZURE_STAGING_BOUNDARY.federatedCredentialName,
      issuer: "https://token.actions.githubusercontent.com",
      subject: buildImmutableSubject(),
      description: "Immutable GitHub Actions trust for Atoms phase3-staging",
      audiences: ["api://AzureADTokenExchange"],
    };
    dependencies.run("az", [
      "ad",
      "app",
      "federated-credential",
      "create",
      "--id",
      application.id,
      "--parameters",
      JSON.stringify(credential),
      "--output",
      "none",
    ]);
    dependencies.log("Created the immutable GitHub environment federated credential.");
  }

  dependencies.run("gh", buildGitHubImmutableOidcArguments());
  const oidcConfiguration = runJson(
    dependencies,
    "gh",
    ["api", `repos/${AZURE_STAGING_BOUNDARY.repository}/actions/oidc/customization/sub`],
    "GitHub immutable OIDC verification",
  );
  if (oidcConfiguration.use_immutable_subject !== true) {
    throw new Error("GitHub did not confirm immutable OIDC subjects for the repository");
  }
  dependencies.log("Enabled immutable GitHub OIDC subjects for the pinned repository ID.");

  const assignments = runJson(
    dependencies,
    "az",
    [
      "role",
      "assignment",
      "list",
      "--assignee",
      servicePrincipal.id,
      "--scope",
      scope,
      "--output",
      "json",
    ],
    "Azure role-assignment lookup",
  );
  for (const role of AZURE_STAGING_ROLES) {
    const assigned = assignments.some(
      (assignment) =>
        assignment.scope?.toLowerCase() === scope.toLowerCase() &&
        assignment.roleDefinitionId?.toLowerCase().endsWith(`/roledefinitions/${role.id}`),
    );
    if (!assigned) {
      dependencies.run(
        "az",
        buildRoleAssignmentArguments({
          principalId: servicePrincipal.id,
          roleId: role.id,
          scope,
        }),
      );
      dependencies.log(`Assigned ${role.name} at atoms-staging-rg scope only.`);
    }
  }

  configureGitHubSecrets(dependencies, {
    AZURE_CLIENT_ID: application.appId,
    AZURE_TENANT_ID: account.tenantId,
    AZURE_SUBSCRIPTION_ID: account.id,
    AZURE_STAGING_SSH_PUBLIC_KEY: publicKey,
    AZURE_STAGING_SSH_SOURCE_CIDR: options.sshSourceCidr,
    AZURE_BUDGET_CONTACT_EMAIL: options.budgetEmail,
  });

  dependencies.log("Azure OIDC bootstrap completed; no VM, disk, IP, or domain was created.");
  dependencies.log("Next safe action: dispatch the Azure staging host workflow in what-if mode.");
  return { mode: options.mode, scope, changed: true };
}

export function runProcess(command, arguments_, options = {}) {
  const result = spawnSync(command, arguments_, {
    encoding: "utf8",
    input: options.input,
    maxBuffer: 10 * 1024 * 1024,
    shell: false,
    windowsHide: true,
  });
  if (result.error?.code === "ENOENT") {
    throw new Error(`Required command is not installed: ${command}`);
  }
  if (result.error !== undefined) {
    throw new Error(`${command} could not be started`);
  }
  if (result.status !== 0) {
    throw new Error(
      `${command} command failed; authenticate securely and review that tool's local output`,
    );
  }
  return result.stdout.trim();
}

export async function main(arguments_ = process.argv.slice(2)) {
  try {
    const options = parseAzureOidcBootstrapArguments(arguments_);
    return await bootstrapAzureStagingOidc(options);
  } catch (error) {
    console.error(`Azure OIDC bootstrap stopped safely: ${error.message}`);
    console.error("No Azure compute deployment was attempted.");
    process.exitCode = 1;
    return undefined;
  }
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) await main();
