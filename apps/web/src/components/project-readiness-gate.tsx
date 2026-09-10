"use client";

import {
  InteractionRequiredAuthError,
  PublicClientApplication,
  type AccountInfo,
  type IPublicClientApplication,
} from "@azure/msal-browser";
import {
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  FolderPlus,
  LoaderCircle,
  LockKeyhole,
  LogIn,
  LogOut,
} from "lucide-react";
import {
  useEffect,
  useMemo,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";

import { createDevelopmentAccessTokenProvider } from "../lib/browser-auth";
import {
  ControlApiClient,
  type ControlApiAccessTokenProvider,
} from "../lib/control-api";
import {
  createEntraAccessTokenProvider,
  createEntraRedirectUri,
  resolveBrowserAuthenticationMode,
  type EntraBrowserConfiguration,
} from "../lib/entra-auth";
import {
  createProjectAndVerify,
  type ProjectReadinessClient,
} from "../lib/project-readiness";
import type { ProjectResponse, WorkspaceSummary } from "@atoms/contracts";

const CONTROL_API_URL =
  process.env.NEXT_PUBLIC_CONTROL_API_URL ?? "http://localhost:3001";
const DEVELOPMENT_ACCESS_TOKEN_PROVIDER = createDevelopmentAccessTokenProvider({
  nodeEnv: process.env.NODE_ENV,
  configuredToken: process.env.NEXT_PUBLIC_CONTROL_API_ACCESS_TOKEN,
});
const authenticationMode = resolveBrowserAuthenticationMode({
  nodeEnv: process.env.NODE_ENV,
  clientId: process.env.NEXT_PUBLIC_ENTRA_CLIENT_ID,
  authority: process.env.NEXT_PUBLIC_ENTRA_AUTHORITY,
  tenantId: process.env.NEXT_PUBLIC_ENTRA_TENANT_ID,
  apiScope: process.env.NEXT_PUBLIC_ENTRA_API_SCOPE,
});

export function ProjectReadinessGate() {
  if (authenticationMode.kind === "development") {
    return (
      <ProjectReadinessSurface
        accessTokenProvider={DEVELOPMENT_ACCESS_TOKEN_PROVIDER}
        identityLabel="Development auth"
      />
    );
  }

  if (authenticationMode.kind === "configuration_error") {
    return (
      <ReadinessFrame>
        <div className="rounded-2xl border border-[#67333a] bg-[#1c1014] p-5" role="alert">
          <AlertTriangle className="text-[#ff8a96]" size={24} aria-hidden="true" />
          <h1 className="mt-4 text-xl font-semibold">Authentication is not configured</h1>
          <p className="mt-2 text-sm leading-6 text-[#c3a7ad]">
            {authenticationMode.message}
          </p>
        </div>
      </ReadinessFrame>
    );
  }

  return <EntraReadinessBoundary configuration={authenticationMode.configuration} />;
}

function EntraReadinessBoundary({
  configuration,
}: {
  readonly configuration: EntraBrowserConfiguration;
}) {
  const [client, setClient] = useState<IPublicClientApplication | undefined>();
  const [account, setAccount] = useState<AccountInfo | null | undefined>(undefined);
  const [authError, setAuthError] = useState<string | undefined>();
  const [signingOut, setSigningOut] = useState(false);

  useEffect(() => {
    let active = true;
    const redirectUri = createEntraRedirectUri(globalThis.location.origin);
    const instance = new PublicClientApplication({
      auth: {
        clientId: configuration.clientId,
        authority: configuration.authority,
        knownAuthorities: [...configuration.knownAuthorities],
        redirectUri,
        postLogoutRedirectUri: globalThis.location.origin,
      },
      cache: { cacheLocation: "sessionStorage" },
    });

    void (async () => {
      await instance.initialize();
      const redirectResult = await instance.handleRedirectPromise();
      const nextAccount =
        redirectResult?.account ??
        instance.getActiveAccount() ??
        instance.getAllAccounts()[0] ??
        null;

      if (nextAccount !== null) instance.setActiveAccount(nextAccount);
      if (!active) return;
      setClient(instance);
      setAccount(nextAccount);
      setAuthError(undefined);
    })().catch((error: unknown) => {
      console.error("Failed to initialize Microsoft Entra project readiness authentication", error);
      if (!active) return;
      setAuthError("Microsoft Entra External ID is temporarily unavailable.");
      setAccount(null);
    });

    return () => {
      active = false;
    };
  }, [configuration]);

  const accessTokenProvider = useMemo(() => {
    if (client === undefined || account === undefined || account === null) {
      return undefined;
    }

    const silentProvider = createEntraAccessTokenProvider(
      {
        acquireTokenSilent: async (request) => {
          const result = await client.acquireTokenSilent({
            account,
            scopes: [...request.scopes],
          });
          return { accessToken: result.accessToken };
        },
      },
      account,
      configuration.apiScope,
    );

    return async () => {
      try {
        return await silentProvider();
      } catch (error) {
        if (error instanceof InteractionRequiredAuthError) {
          await client.acquireTokenRedirect({
            account,
            scopes: [configuration.apiScope],
          });
          return undefined;
        }
        throw error;
      }
    };
  }, [account, client, configuration.apiScope]);

  async function signIn() {
    if (client === undefined) return;
    setAuthError(undefined);
    try {
      await client.loginRedirect({
        scopes: [
          "openid",
          "profile",
          "offline_access",
          configuration.apiScope,
        ],
      });
    } catch (error: unknown) {
      console.error("Failed to start Microsoft Entra project readiness sign-in", error);
      setAuthError("Sign-in could not be started. Please try again.");
    }
  }

  async function signOut() {
    if (client === undefined || account === undefined || account === null) return;
    setSigningOut(true);
    setAuthError(undefined);
    try {
      await client.logoutRedirect({
        account,
        postLogoutRedirectUri: globalThis.location.origin,
      });
    } catch (error: unknown) {
      console.error("Failed to sign out from Microsoft Entra", error);
      setAuthError("Sign-out failed. Please try again.");
      setSigningOut(false);
    }
  }

  if (account === undefined || client === undefined) {
    return (
      <ReadinessFrame>
        <div className="flex items-center justify-center gap-3 rounded-2xl border border-[#252d3a] bg-[#0d121a] p-8 text-sm text-[#aab5c5]">
          <LoaderCircle className="animate-spin text-[#78e6bd]" size={20} />
          Restoring your secure session…
        </div>
      </ReadinessFrame>
    );
  }

  if (account === null) {
    return (
      <ReadinessFrame>
        <div className="rounded-2xl border border-[#252d3a] bg-[#0d121a] p-5 shadow-2xl shadow-black/30">
          <div className="grid size-11 place-items-center rounded-xl border border-[#36554b] bg-[#10251e] text-[#78e6bd]">
            <LockKeyhole size={21} aria-hidden="true" />
          </div>
          <h1 className="mt-5 text-2xl font-semibold tracking-tight">Project readiness</h1>
          <p className="mt-2 text-sm leading-6 text-[#98a5b7]">
            Sign in with Microsoft Entra to create project metadata without starting an agent run.
          </p>
          {authError !== undefined ? (
            <div className="mt-4 rounded-xl border border-[#67333a] bg-[#1c1014] px-3 py-2 text-sm text-[#ff9ca6]" role="alert">
              {authError}
            </div>
          ) : null}
          <button
            className="mt-6 inline-flex w-full items-center justify-center gap-2 rounded-xl bg-[#78e6bd] px-4 py-3 text-sm font-bold text-[#06281e]"
            type="button"
            onClick={() => void signIn()}
          >
            <LogIn size={17} />
            Continue with Microsoft
          </button>
        </div>
      </ReadinessFrame>
    );
  }

  return (
    <ProjectReadinessSurface
      accessTokenProvider={accessTokenProvider}
      identityLabel={account.name ?? account.username ?? account.homeAccountId}
      signingOut={signingOut}
      onSignOut={() => void signOut()}
      authenticationError={authError}
    />
  );
}

function ProjectReadinessSurface({
  accessTokenProvider,
  identityLabel,
  signingOut = false,
  onSignOut,
  authenticationError,
}: {
  readonly accessTokenProvider?: ControlApiAccessTokenProvider;
  readonly identityLabel?: string;
  readonly signingOut?: boolean;
  readonly onSignOut?: () => void;
  readonly authenticationError?: string;
}) {
  const client = useMemo<ProjectReadinessClient>(
    () =>
      new ControlApiClient({
        baseUrl: CONTROL_API_URL,
        accessTokenProvider,
      }),
    [accessTokenProvider],
  );
  const [workspaces, setWorkspaces] = useState<readonly WorkspaceSummary[]>([]);
  const [workspaceId, setWorkspaceId] = useState("");
  const [projectName, setProjectName] = useState("Readiness project");
  const [projectSlug, setProjectSlug] = useState("readiness-project");
  const [busy, setBusy] = useState(false);
  const [loadingWorkspaces, setLoadingWorkspaces] = useState(true);
  const [error, setError] = useState<string | undefined>();
  const [createdProject, setCreatedProject] = useState<ProjectResponse | undefined>();

  useEffect(() => {
    let active = true;
    setLoadingWorkspaces(true);
    void client
      .listWorkspaces()
      .then((response) => {
        if (!active) return;
        setWorkspaces(response.items);
        setWorkspaceId(response.items[0]?.id ?? "");
        setError(undefined);
      })
      .catch((caught: unknown) => {
        if (!active) return;
        setError(`Could not load workspaces: ${toMessage(caught)}`);
      })
      .finally(() => {
        if (active) setLoadingWorkspaces(false);
      });

    return () => {
      active = false;
    };
  }, [client]);

  async function createProjectOnly(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (createdProject !== undefined || workspaceId.length === 0) return;

    setBusy(true);
    setError(undefined);
    try {
      const project = await createProjectAndVerify(client, {
        workspaceId,
        name: projectName.trim(),
        slug: projectSlug.trim(),
        description: "Created from the Atoms project-only readiness surface; no run requested",
      });
      setCreatedProject(project);
    } catch (caught: unknown) {
      setError(toMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  const locked = createdProject !== undefined || busy;

  return (
    <main className="min-h-screen px-4 py-8 text-white">
      <div className="mx-auto w-full max-w-3xl">
        <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
          <a
            href="/"
            className="inline-flex items-center gap-2 text-sm font-semibold text-[#9fc5ff] hover:text-[#c3d9ff]"
          >
            <ArrowLeft size={16} />
            Back to Atoms workspace
          </a>
          <div className="flex items-center gap-2 text-xs text-[#8f9bad]">
            {identityLabel !== undefined ? (
              <span className="max-w-64 truncate rounded-full border border-[#2b3442] px-2.5 py-1" title={identityLabel}>
                {identityLabel}
              </span>
            ) : null}
            {onSignOut !== undefined ? (
              <button
                type="button"
                className="inline-flex items-center gap-1.5 rounded-lg border border-[#39414d] px-2.5 py-1 text-[#c0cad8] disabled:opacity-55"
                disabled={signingOut}
                onClick={onSignOut}
              >
                {signingOut ? <LoaderCircle className="animate-spin" size={13} /> : <LogOut size={13} />}
                {signingOut ? "Signing out" : "Sign out"}
              </button>
            ) : null}
          </div>
        </div>

        <section className="rounded-3xl border border-[#252d3a] bg-[#0b1017] p-5 shadow-2xl shadow-black/30 md:p-7">
          <div className="flex items-start gap-4">
            <div className="grid size-12 shrink-0 place-items-center rounded-2xl border border-[#36554b] bg-[#10251e] text-[#78e6bd]">
              <FolderPlus size={22} aria-hidden="true" />
            </div>
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[#78e6bd]">Non-billable readiness</p>
              <h1 className="mt-1 text-2xl font-semibold tracking-tight">Create project only</h1>
              <p className="mt-2 text-sm leading-6 text-[#98a5b7]">
                This surface persists and reads back project metadata only. It has no run controls and does not start agents, OpenAI, or E2B.
              </p>
            </div>
          </div>

          {authenticationError !== undefined ? (
            <div className="mt-5 rounded-xl border border-[#67333a] bg-[#1c1014] px-3 py-2 text-sm text-[#ff9ca6]" role="alert">
              {authenticationError}
            </div>
          ) : null}
          {error !== undefined ? (
            <div className="mt-5 rounded-xl border border-[#67333a] bg-[#1c1014] px-3 py-2 text-sm text-[#ff9ca6]" role="alert">
              {error}
            </div>
          ) : null}

          {createdProject !== undefined ? (
            <div className="mt-6 rounded-2xl border border-[#315347] bg-[#10241e] p-5">
              <div className="flex items-center gap-2 text-[#8af0c9]">
                <CheckCircle2 size={20} />
                <h2 className="font-semibold">Project created and verified</h2>
              </div>
              <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-2">
                <div>
                  <dt className="text-[#7f8b9d]">Name</dt>
                  <dd className="mt-1 text-[#dbe5f2]">{createdProject.name}</dd>
                </div>
                <div>
                  <dt className="text-[#7f8b9d]">Slug</dt>
                  <dd className="mt-1 font-mono text-[#dbe5f2]">{createdProject.slug}</dd>
                </div>
                <div className="sm:col-span-2">
                  <dt className="text-[#7f8b9d]">Project ID</dt>
                  <dd className="mt-1 break-all font-mono text-xs text-[#dbe5f2]">{createdProject.id}</dd>
                </div>
              </dl>
              <p className="mt-4 text-xs leading-5 text-[#89a79c]">
                Verified with a separate authenticated project readback. No run request was sent.
              </p>
            </div>
          ) : (
            <form className="mt-6 space-y-4" onSubmit={createProjectOnly}>
              <label className="block">
                <span className="mb-1.5 block text-sm font-medium text-[#c8d1de]">Workspace</span>
                <select
                  className="w-full rounded-xl border border-[#303a48] bg-[#0a0f16] px-3 py-2.5 text-sm text-white outline-none focus:border-[#5b8f7d] disabled:opacity-60"
                  value={workspaceId}
                  disabled={loadingWorkspaces || locked || workspaces.length === 0}
                  required
                  onChange={(event) => setWorkspaceId(event.target.value)}
                >
                  {workspaces.length === 0 ? (
                    <option value="">{loadingWorkspaces ? "Loading workspaces…" : "No authorized workspaces"}</option>
                  ) : (
                    workspaces.map((workspace) => (
                      <option key={workspace.id} value={workspace.id}>
                        {workspace.name} ({workspace.slug})
                      </option>
                    ))
                  )}
                </select>
              </label>

              <div className="grid gap-4 sm:grid-cols-2">
                <label className="block">
                  <span className="mb-1.5 block text-sm font-medium text-[#c8d1de]">Project name</span>
                  <input
                    className="w-full rounded-xl border border-[#303a48] bg-[#0a0f16] px-3 py-2.5 text-sm text-white outline-none focus:border-[#5b8f7d] disabled:opacity-60"
                    value={projectName}
                    maxLength={160}
                    disabled={locked}
                    required
                    onChange={(event) => {
                      const nextName = event.target.value;
                      setProjectName(nextName);
                      setProjectSlug(slugify(nextName));
                    }}
                  />
                </label>
                <label className="block">
                  <span className="mb-1.5 block text-sm font-medium text-[#c8d1de]">Slug</span>
                  <input
                    className="w-full rounded-xl border border-[#303a48] bg-[#0a0f16] px-3 py-2.5 font-mono text-sm text-white outline-none focus:border-[#5b8f7d] disabled:opacity-60"
                    value={projectSlug}
                    maxLength={100}
                    pattern="[a-z0-9]+(?:-[a-z0-9]+)*"
                    disabled={locked}
                    required
                    onChange={(event) => setProjectSlug(event.target.value)}
                  />
                </label>
              </div>

              <button
                className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-[#78e6bd] px-4 py-3 text-sm font-bold text-[#06281e] transition hover:bg-[#91efd0] disabled:cursor-not-allowed disabled:opacity-50"
                type="submit"
                disabled={
                  busy ||
                  loadingWorkspaces ||
                  workspaceId.length === 0 ||
                  projectName.trim().length === 0 ||
                  projectSlug.trim().length === 0
                }
              >
                {busy ? <LoaderCircle className="animate-spin" size={17} /> : <FolderPlus size={17} />}
                {busy ? "Creating and verifying…" : "Create project only — no run"}
              </button>
            </form>
          )}
        </section>
      </div>
    </main>
  );
}

function ReadinessFrame({ children }: { readonly children: ReactNode }) {
  return (
    <main className="grid min-h-screen place-items-center px-4 py-10 text-white">
      <div className="w-full max-w-md">{children}</div>
    </main>
  );
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 100);
}

function toMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unexpected project readiness error";
}
