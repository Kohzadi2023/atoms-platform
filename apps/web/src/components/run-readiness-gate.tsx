"use client";

import type { WorkspaceSummary } from "@atoms/contracts";
import {
  InteractionRequiredAuthError,
  PublicClientApplication,
  type AccountInfo,
  type IPublicClientApplication,
} from "@azure/msal-browser";
import {
  AlertTriangle,
  CheckCircle2,
  LoaderCircle,
  LockKeyhole,
  LogIn,
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
      <Frame>
        <div className="rounded-2xl border border-[#67333a] bg-[#1c1014] p-5" role="alert">
          <AlertTriangle className="text-[#ff8a96]" size={24} />
          <h1 className="mt-4 text-xl font-semibold">Authentication is not configured</h1>
          <p className="mt-2 text-sm leading-6 text-[#c3a7ad]">{authenticationMode.message}</p>
        </div>
      </Frame>
    );
  }

  return <EntraBoundary configuration={authenticationMode.configuration} />;
}

function EntraBoundary({ configuration }: { readonly configuration: EntraBrowserConfiguration }) {
  const [client, setClient] = useState<IPublicClientApplication>();
  const [account, setAccount] = useState<AccountInfo | null>();
  const [error, setError] = useState<string>();

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
        redirectResult?.account ?? instance.getActiveAccount() ?? instance.getAllAccounts()[0] ?? null;
      if (nextAccount !== null) instance.setActiveAccount(nextAccount);
      if (!active) return;
      setClient(instance);
      setAccount(nextAccount);
      setError(undefined);
    })().catch((caught: unknown) => {
      console.error("Failed to initialize Microsoft Entra run readiness authentication", caught);
      if (!active) return;
      setClient(instance);
      setAccount(null);
      setError("Microsoft Entra External ID is temporarily unavailable.");
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
      } catch (caught) {
        if (caught instanceof InteractionRequiredAuthError) {
          await client.acquireTokenRedirect({ account, scopes: [configuration.apiScope] });
          return undefined;
        }
        throw caught;
      }
    };
  }, [account, client, configuration.apiScope]);

  if (client === undefined || account === undefined) {
    return <Loading label="Restoring your secure session…" />;
  }

  if (account === null) {
    return (
      <Frame>
        <div className="rounded-2xl border border-[#252d3a] bg-[#0d121a] p-5 shadow-2xl shadow-black/30">
          <div className="grid size-11 place-items-center rounded-xl border border-[#36554b] bg-[#10251e] text-[#78e6bd]">
            <LockKeyhole size={21} />
          </div>
          <h1 className="mt-5 text-2xl font-semibold">Run readiness</h1>
          <p className="mt-2 text-sm leading-6 text-[#98a5b7]">
            Prepare a project and validate the controlled live-run contract without starting a run.
          </p>
          {error === undefined ? null : (
            <div className="mt-4 rounded-xl border border-[#67333a] bg-[#1c1014] px-3 py-2 text-sm text-[#ff9ca6]" role="alert">
              {error}
            </div>
          )}
          <button
            type="button"
            className="mt-6 inline-flex w-full items-center justify-center gap-2 rounded-xl bg-[#78e6bd] px-4 py-3 text-sm font-bold text-[#06281e]"
            onClick={() =>
              void client.loginRedirect({
                scopes: ["openid", "profile", "offline_access", configuration.apiScope],
              })
            }
          >
            <LogIn size={17} />
            Continue with Microsoft
          </button>
        </div>
      </Frame>
    );
  }

  if (accessTokenProvider === undefined) {
    return <Loading label="Preparing Control API access…" />;
  }

  return (
    <RunReadinessSurface
      accessTokenProvider={accessTokenProvider}
      identityLabel={account.name ?? account.username ?? account.homeAccountId}
    />
  );
}

function RunReadinessSurface({
  accessTokenProvider,
  identityLabel,
}: {
  readonly accessTokenProvider: ControlApiAccessTokenProvider;
  readonly identityLabel: string;
}) {
  const client = useMemo<RunReadinessClient>(
    () => new ControlApiClient({ baseUrl: CONTROL_API_URL, accessTokenProvider }),
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
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [prepared, setPrepared] = useState<PreparedRunReadiness>();

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
        if (active) setLoading(false);
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
      setPrepared(
        await prepareRunReadiness(client, {
          workspaceId,
          projectName,
          projectSlug,
          prompt,
          maximumCostCad: numericCost,
          providerConfirmation,
        }),
      );
    } catch (caught: unknown) {
      setError(toMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="min-h-screen px-4 py-8 text-white">
      <div className="mx-auto w-full max-w-3xl">
        <div className="mb-5 flex items-center justify-between gap-3 text-sm">
          <a href="/" className="font-semibold text-[#9fc5ff] hover:text-[#c3d9ff]">← Back to Atoms workspace</a>
          <span className="max-w-64 truncate rounded-full border border-[#2b3442] px-2.5 py-1 text-xs text-[#8f9bad]" title={identityLabel}>
            {identityLabel}
          </span>
        </div>

        <section className="rounded-3xl border border-[#252d3a] bg-[#0b1017] p-5 shadow-2xl shadow-black/30 md:p-7">
          <div className="flex items-start gap-4">
            <div className="grid size-12 shrink-0 place-items-center rounded-2xl border border-[#36554b] bg-[#10251e] text-[#78e6bd]">
              <ShieldCheck size={22} />
            </div>
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[#78e6bd]">Non-billable run readiness</p>
              <h1 className="mt-1 text-2xl font-semibold">Prepare a controlled live run</h1>
              <p className="mt-2 text-sm leading-6 text-[#98a5b7]">
                Creates and verifies project metadata, validates the exact provider confirmation and a CAD cost ceiling, and then stops. This surface has no run controls.
              </p>
            </div>
          </div>

          {error === undefined ? null : (
            <div className="mt-5 rounded-xl border border-[#67333a] bg-[#1c1014] px-3 py-2 text-sm text-[#ff9ca6]" role="alert">
              {error}
            </div>
          )}

          {prepared === undefined ? (
            <form className="mt-6 space-y-4" onSubmit={prepare}>
              <Field label="Workspace">
                <select
                  className={inputClass}
                  value={workspaceId}
                  disabled={loading || busy || workspaces.length === 0}
                  required
                  onChange={(event) => setWorkspaceId(event.target.value)}
                >
                  {workspaces.length === 0 ? (
                    <option value="">{loading ? "Loading workspaces…" : "No authorized workspaces"}</option>
                  ) : (
                    workspaces.map((workspace) => (
                      <option key={workspace.id} value={workspace.id}>{workspace.name} ({workspace.slug})</option>
                    ))
                  )}
                </select>
              </Field>

              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Project name">
                  <input className={inputClass} value={projectName} maxLength={160} required onChange={(event) => setProjectName(event.target.value)} />
                </Field>
                <Field label="Project slug">
                  <input className={`${inputClass} font-mono`} value={projectSlug} maxLength={100} pattern="[a-z0-9]+(?:-[a-z0-9]+)*" required onChange={(event) => setProjectSlug(event.target.value)} />
                </Field>
              </div>

              <Field label="Run prompt">
                <textarea className={`${inputClass} min-h-32 leading-6`} value={prompt} maxLength={100000} required onChange={(event) => setPrompt(event.target.value)} />
              </Field>

              <Field label="Maximum live-run cost (CAD)">
                <input className={inputClass} type="number" min="0.01" max={MAX_ALLOWED_COST_CAD} step="0.01" value={maximumCostCad} required onChange={(event) => setMaximumCostCad(event.target.value)} />
              </Field>

              <Field label="Exact provider confirmation">
                <input className={`${inputClass} font-mono text-xs`} value={providerConfirmation} autoComplete="off" spellCheck={false} required onChange={(event) => setProviderConfirmation(event.target.value)} />
                <p className="mt-1.5 break-all font-mono text-xs text-[#7f8b9b]">{LIVE_PROVIDER_CONFIRMATION}</p>
              </Field>

              <p className="rounded-xl border border-[#4b3f26] bg-[#1c180d] px-3 py-2 text-xs leading-5 text-[#ddc78d]">
                Live execution is a separate explicit action. Readiness cost ceiling: CAD {MAX_ALLOWED_COST_CAD.toFixed(2)}.
              </p>

              <button
                className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-[#78e6bd] px-4 py-3 text-sm font-bold text-[#06281e] disabled:cursor-not-allowed disabled:opacity-50"
                type="submit"
                disabled={busy || loading || workspaceId.length === 0 || consent.violations.length > 0}
              >
                {busy ? <LoaderCircle className="animate-spin" size={17} /> : <ShieldCheck size={17} />}
                {busy ? "Preparing and verifying…" : "Prepare run readiness — no execution"}
              </button>
            </form>
          ) : (
            <div className="mt-6 rounded-2xl border border-[#315347] bg-[#10241e] p-5">
              <div className="flex items-center gap-2 text-[#8af0c9]">
                <CheckCircle2 size={20} />
                <h2 className="font-semibold">Run readiness prepared</h2>
              </div>
              <p className="mt-4 text-sm text-[#dbe5f2]">{prepared.project.name}</p>
              <p className="mt-1 font-mono text-xs text-[#9fb0c4]">{prepared.project.slug}</p>
              <p className="mt-2 text-sm text-[#dbe5f2]">Cost ceiling: CAD {prepared.maximumCostCad.toFixed(2)}</p>
              <p className="mt-4 text-xs leading-5 text-[#89a79c]">
                Project creation and authenticated readback passed. No run request, queue job, agent, OpenAI call, or E2B sandbox was started.
              </p>
            </div>
          )}
        </section>
      </div>
    </main>
  );
}

const inputClass =
  "w-full rounded-xl border border-[#303a48] bg-[#0a0f16] px-3 py-2.5 text-sm text-white outline-none focus:border-[#5b8f7d] disabled:opacity-60";

function Field({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-sm font-medium text-[#c8d1de]">{label}</span>
      {children}
    </label>
  );
}

function Loading({ label }: { readonly label: string }) {
  return (
    <Frame>
      <div className="flex items-center justify-center gap-3 rounded-2xl border border-[#252d3a] bg-[#0d121a] p-8 text-sm text-[#aab5c5]">
        <LoaderCircle className="animate-spin text-[#78e6bd]" size={20} />
        {label}
      </div>
    </Frame>
  );
}

function Frame({ children }: { readonly children: ReactNode }) {
  return <main className="grid min-h-screen place-items-center px-4 py-10 text-white"><div className="w-full max-w-md">{children}</div></main>;
}

function toMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unexpected run readiness error";
}
