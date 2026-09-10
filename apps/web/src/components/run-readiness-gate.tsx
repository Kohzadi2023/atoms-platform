"use client";

import type { ProjectResponse, WorkspaceSummary } from "@atoms/contracts";
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
  LoaderCircle,
  LockKeyhole,
  LogIn,
  LogOut,
  ShieldCheck,
} from "lucide-react";
import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";

import { createDevelopmentAccessTokenProvider } from "../lib/browser-auth";
import { ControlApiClient, type ControlApiAccessTokenProvider } from "../lib/control-api";
import {
  createEntraAccessTokenProvider,
  createEntraRedirectUri,
  resolveBrowserAuthenticationMode,
  type EntraBrowserConfiguration,
} from "../lib/entra-auth";
import {
  LIVE_PROVIDER_CONFIRMATION,
  MAX_ALLOWED_COST_CAD,
  prepareRunReadiness,
  validateLiveRunConsent,
  type PreparedRunReadiness,
  type RunReadinessClient,
} from "../lib/run-readiness";

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

export function RunReadinessGate() {
  if (authenticationMode.kind === "development") {
    return (
      <RunReadinessSurface
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

  return <EntraRunReadinessBoundary configuration={authenticationMode.configuration} />;
}

function EntraRunReadinessBoundary({
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
    const instance = new PublicClientApplication({
      auth: {
        clientId: configuration.clientId,
        authority: configuration.authority,
        knownAuthorities: [...configuration.knownAuthorities],
        redirectUri: createEntraRedirectUri(globalThis.location.origin),
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
      console.error("Failed to initialize Microsoft Entra run readiness authentication", error);
      if (!active) return;
      setAuthError("Microsoft Entra External ID is temporarily unavailable.");
      setAccount(null);
    });

    return () => {
      active = false;
    };
  }, [configuration]);

  const accessTokenProvider = useMemo<ControlApiAccessTokenProvider | undefined>(() => {
    if (client === undefined || account === undefined || account === null) return undefined;
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
        scopes: ["openid", "profile", "offline_access", configuration.apiScope],
      });
    } catch (error: unknown) {
      console.error("Failed to start Microsoft Entra run readiness sign-in", error);
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

  if (client === undefined || account === undefined) {
    return <LoadingFrame label="Restoring your secure session…" />;
  }

  if (account === null) {
    return (
      <ReadinessFrame>
        <div className="rounded-2xl border border-[#252d3a] bg-[#0d121a] p-5 shadow-2xl shadow-black/30">
          <div className="grid size-11 place-items-center rounded-xl border border-[#36554b] bg-[#10251e] text-[#78e6bd]">
            <LockKeyhole size={21} aria-hidden="true" />
          </div>
          <h1 className="mt-5 text-2xl font-semibold tracking-tight">Run readiness</h1>
          <p className="mt-2 text-sm leading-6 text-[#98a5b7]">
            Sign in to prepare a project and validate the live-run consent contract without starting a run.
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

  if (accessTokenProvider === undefined) {
    return <LoadingFrame label="Preparing Control API access…" />;
  }

  return (
    <RunReadinessSurface
      accessTokenProvider={accessTokenProvider}
      identityLabel={account.name ?? account.username ?? account.homeAccountId}
      signingOut={signingOut}
      onSignOut={() => void signOut()}
    />
  );
}

function RunReadinessSurface({
  accessTokenProvider,
  identityLabel,
  signingOut = false,
  onSignOut,
}: {
  readonly accessTokenProvider: ControlApiAccessTokenProvider;
  readonly identityLabel: string;
  readonly signingOut?: boolean;
  readonly onSignOut?: () => void;
}) {
  const client = useMemo<RunReadinessClient>(
    () =>
      new ControlApiClient({
        baseUrl: CONTROL_API_URL,
        accessTokenProvider,
      }),
    [accessTokenProvider],
  );
  const [workspaces, setWorkspaces] = useState<readonly WorkspaceSummary[]>([]);
  const [workspaceId, setWorkspaceId] = useState("");
  const [projectName, setProjectName] = useState("Run readiness project");
  const [projectSlug, setProjectSlug] = useState("readiness-project");
  const [prompt, setPrompt] = useState(
    "Build a small deterministic staging feature, run tests, and stop at the first approval gate.",
  );
  const [maximumCostCad, setMaximumCostCad] = useState("1");
  const [providerConfirmation, setProviderConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const [loadingWorkspaces, setLoadingWorkspaces] = useState(true);
  const [error, setError] = useState<string | undefined>();
  const [prepared, setPrepared] = useState<PreparedRunReadiness | undefined>();

  useEffect(() => {
    let active = true;
    void client
      .listWorkspaces()
      .then((response) => {
        if (!active) return;
        setWorkspaces(response.items);
        setWorkspaceId(response.items[0]?.id ?? "");
        setError(undefined);
      })
      .catch((caught: unknown) => {
        if (active) setError(`Could not load workspaces: ${toMessage(caught)}`);
      })
      .finally(() => {
        if (active) setLoadingWorkspaces(false);
      });
    return () => {
      active = false;
    };
  }, [client]);

  const numericCost = Number(maximumCostCad);
  const consent = validateLiveRunConsent({
    prompt,
    maximumCostCad: numericCost,
    providerConfirmation,
  });

  async function prepare(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (workspaceId.length === 0 || prepared !== undefined) return;
    setBusy(true);
    setError(undefined);
    try {
      const result = await prepareRunReadiness(client, {
        workspaceId,
        projectName,
        projectSlug,
        prompt,
        maximumCostCad: numericCost,
        providerConfirmation,
      });
      setPrepared(result);
    } catch (caught: unknown) {
      setError(toMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="min-h-screen px-4 py-8 text-white">
      <div className="mx-auto w-full max-w-3xl">
        <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
          <a href="/" className="inline-flex items-center gap-2 text-sm font-semibold text-[#9fc5ff] hover:text-[#c3d9ff]">
            <ArrowLeft size={16} />
            Back to Atoms workspace
          </a>
          <div className="flex items-center gap-2 text-xs text-[#8f9bad]">
            <span className="max-w-64 truncate rounded-full border border-[#2b3442] px-2.5 py-1" title={identityLabel}>
              {identityLabel}
            </span>
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
              <ShieldCheck size={22} aria-hidden="true" />
            </div>
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[#78e6bd]">Non-billable run readiness</p>
              <h1 className="mt-1 text-2xl font-semibold tracking-tight">Prepare a controlled live run</h1>
              <p className="mt-2 text-sm leading-6 text-[#98a5b7]">
                This page creates and verifies project metadata, validates the exact provider confirmation and a CAD cost ceiling, and then stops. It has no run controls.
              </p>
            </div>
          </div>

          {error !== undefined ? (
            <div className="mt-5 rounded-xl border border-[#67333a] bg-[#1c1014] px-3 py-2 text-sm text-[#ff9ca6]" role="alert">
              {error}
            </div>
          ) : null}

          {prepared !== undefined ? (
            <div className="mt-6 rounded-2xl border border-[#315347] bg-[#10241e] p-5">
              <div className="flex items-center gap-2 text-[#8af0c9]">
                <CheckCircle2 size={20} />
                <h2 className="font-semibold">Run readiness prepared</h2>
              </div>
              <dl className="mt-4 grid gap-2 text-sm">
                <div className="flex justify-between gap-4"><dt className="text-[#91a0b3]">Project</dt><dd className="text-right text-[#dbe5f2]">{prepared.project.name}</dd></div>
                <div className="flex justify-between gap-4"><dt className="text-[#91a0b3]">Slug</dt><dd className="font-mono text-right text-[#dbe5f2]">{prepared.project.slug}</dd></div>
                <div className="flex justify-between gap-4"><dt className="text-[#91a0b3]">Max cost</dt><dd className="text-right text-[#dbe5f2]">CAD {prepared.maximumCostCad.toFixed(2)}</dd></div>
              </dl>
              <p className="mt-4 text-xs leading-5 text-[#89a79c]">
                Project creation and authenticated readback passed. No run request, queue job, agent, OpenAI call, or E2B sandbox was started. Live execution remains a separate explicit action.
              </p>
            </div>
          ) : (
            <form className="mt-6 space-y-4" onSubmit={prepare}>
              <label className="block">
                <span className="mb-1.5 block text-sm font-medium text-[#c8d1de]">Workspace</span>
                <select
                  className="w-full rounded-xl border border-[#303a48] bg-[#0a0f16] px-3 py-2.5 text-sm text-white outline-none focus:border-[#5b8f7d] disabled:opacity-60"
                  value={workspaceId}
                  disabled={loadingWorkspaces || busy || workspaces.length === 0}
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
                    className="w-full rounded-xl border border-[#303a48] bg-[#0a0f16] px-3 py-2.5 text-sm text-white outline-none focus:border-[#5b8f7d]"
                    value={projectName}
                    maxLength={160}
                    required
                    onChange={(event) => setProjectName(event.target.value)}
                  />
                </label>
                <label className="block">
                  <span className="mb-1.5 block text-sm font-medium text-[#c8d1de]">Project slug</span>
                  <input
                    className="w-full rounded-xl border border-[#303a48] bg-[#0a0f16] px-3 py-2.5 font-mono text-sm text-white outline-none focus:border-[#5b8f7d]"
                    value={projectSlug}
                    maxLength={100}
                    pattern="[a-z0-9]+(?:-[a-z0-9]+)*"
                    required
                    onChange={(event) => setProjectSlug(event.target.value)}
                  />
                </label>
              </div>

              <label className="block">
                <span className="mb-1.5 block text-sm font-medium text-[#c8d1de]">Run prompt</span>
                <textarea
                  className="min-h-32 w-full rounded-xl border border-[#303a48] bg-[#0a0f16] px-3 py-2.5 text-sm leading-6 text-white outline-none focus:border-[#5b8f7d]"
                  value={prompt}
                  maxLength={100000}
                  required
                  onChange={(event) => setPrompt(event.target.value)}
                />
              </label>

              <label className="block">
                <span className="mb-1.5 block text-sm font-medium text-[#c8d1de]">Maximum live-run cost (CAD)</span>
                <input
                  className="w-full rounded-xl border border-[#303a48] bg-[#0a0f16] px-3 py-2.5 text-sm text-white outline-none focus:border-[#5b8f7d]"
                  type="number"
                  inputMode="decimal"
                  min="0.01"
                  max={MAX_ALLOWED_COST_CAD}
                  step="0.01"
                  value={maximumCostCad}
                  required
                  onChange={(event) => setMaximumCostCad(event.target.value)}
                />
                <p className="mt-1.5 text-xs text-[#7f8b9b]">Hard readiness ceiling: CAD {MAX_ALLOWED_COST_CAD.toFixed(2)}.</p>
              </label>

              <label className="block">
                <span className="mb-1.5 block text-sm font-medium text-[#c8d1de]">Exact provider confirmation</span>
                <input
                  className="w-full rounded-xl border border-[#303a48] bg-[#0a0f16] px-3 py-2.5 font-mono text-xs text-white outline-none focus:border-[#5b8f7d]"
                  value={providerConfirmation}
                  autoComplete="off"
                  spellCheck={false}
                  required
                  onChange={(event) => setProviderConfirmation(event.target.value)}
                />
                <p className="mt-1.5 break-all font-mono text-xs text-[#7f8b9b]">{LIVE_PROVIDER_CONFIRMATION}</p>
              </label>

              {consent.violations.length > 0 ? (
                <div className="rounded-xl border border-[#4b3f26] bg-[#1c180d] px-3 py-2 text-xs leading-5 text-[#ddc78d]">
                  Readiness is locked until the prompt, cost ceiling, and exact provider confirmation are valid.
                </div>
              ) : null}

              <button
                className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-[#78e6bd] px-4 py-3 text-sm font-bold text-[#06281e] transition hover:bg-[#91efd0] disabled:cursor-not-allowed disabled:opacity-50"
                type="submit"
                disabled={
                  busy ||
                  loadingWorkspaces ||
                  workspaceId.length === 0 ||
                  projectName.trim().length === 0 ||
                  projectSlug.trim().length === 0 ||
                  consent.violations.length > 0
                }
              >
                {busy ? <LoaderCircle className="animate-spin" size={17} /> : <ShieldCheck size={17} />}
                {busy ? "Preparing and verifying…" : "Prepare run readiness — no execution"}
              </button>
            </form>
          )}
        </section>
      </div>
    </main>
  );
}

function LoadingFrame({ label }: { readonly label: string }) {
  return (
    <ReadinessFrame>
      <div className="flex items-center justify-center gap-3 rounded-2xl border border-[#252d3a] bg-[#0d121a] p-8 text-sm text-[#aab5c5]">
        <LoaderCircle className="animate-spin text-[#78e6bd]" size={20} />
        {label}
      </div>
    </ReadinessFrame>
  );
}

function ReadinessFrame({ children }: { readonly children: ReactNode }) {
  return (
    <main className="grid min-h-screen place-items-center px-4 py-10 text-white">
      <div className="w-full max-w-md">{children}</div>
    </main>
  );
}

function toMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unexpected run readiness error";
}
