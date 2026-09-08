"use client";

import {
  InteractionRequiredAuthError,
  PublicClientApplication,
  type AccountInfo,
  type IPublicClientApplication,
} from "@azure/msal-browser";
import {
  AlertTriangle,
  GitBranch,
  LoaderCircle,
  LockKeyhole,
  LogIn,
} from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";

import {
  createEntraAccessTokenProvider,
  resolveBrowserAuthenticationMode,
  type EntraBrowserConfiguration,
} from "../lib/entra-auth";
import { WorkspaceShell } from "./workspace-shell";

const authenticationMode = resolveBrowserAuthenticationMode({
  nodeEnv: process.env.NODE_ENV,
  clientId: process.env.NEXT_PUBLIC_ENTRA_CLIENT_ID,
  authority: process.env.NEXT_PUBLIC_ENTRA_AUTHORITY,
  apiScope: process.env.NEXT_PUBLIC_ENTRA_API_SCOPE,
});
const ACTIVE_RUN_STORAGE_KEY = "atoms.active-run.v1";

export function EntraAuthGate() {
  if (authenticationMode.kind === "development") {
    return <WorkspaceShell identityLabel="Development auth" />;
  }

  if (authenticationMode.kind === "configuration_error") {
    return (
      <AuthenticationFrame>
        <div
          className="rounded-2xl border border-[#67333a] bg-[#1c1014] p-5"
          role="alert"
        >
          <AlertTriangle className="text-[#ff8a96]" size={24} aria-hidden="true" />
          <h1 className="mt-4 text-xl font-semibold">Authentication is not configured</h1>
          <p className="mt-2 text-sm leading-6 text-[#c3a7ad]">
            {authenticationMode.message}
          </p>
          <p className="mt-3 text-xs leading-5 text-[#8f7c82]">
            The production workspace remains unavailable until Microsoft Entra
            External ID is configured.
          </p>
        </div>
      </AuthenticationFrame>
    );
  }

  return <EntraSessionBoundary configuration={authenticationMode.configuration} />;
}

function EntraSessionBoundary({
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
        knownAuthorities: [configuration.knownAuthority],
        redirectUri: globalThis.location.origin,
        postLogoutRedirectUri: globalThis.location.origin,
        navigateToLoginRequestUrl: false,
      },
      cache: {
        cacheLocation: "sessionStorage",
      },
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
    })().catch(() => {
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
    } catch {
      setAuthError("Sign-in could not be started. Please try again.");
    }
  }

  async function signOut() {
    if (client === undefined || account === undefined || account === null) return;
    setSigningOut(true);
    setAuthError(undefined);
    globalThis.localStorage.removeItem(ACTIVE_RUN_STORAGE_KEY);
    try {
      await client.logoutRedirect({
        account,
        postLogoutRedirectUri: globalThis.location.origin,
      });
    } catch {
      setAuthError("Sign-out failed. Please try again.");
      setSigningOut(false);
    }
  }

  if (account === undefined || client === undefined) {
    return (
      <AuthenticationFrame>
        <div className="flex items-center justify-center gap-3 rounded-2xl border border-[#252d3a] bg-[#0d121a] p-8 text-sm text-[#aab5c5]">
          <LoaderCircle className="animate-spin text-[#78e6bd]" size={20} />
          Restoring your secure session…
        </div>
      </AuthenticationFrame>
    );
  }

  if (account === null) {
    return (
      <EntraSignIn
        busy={false}
        error={authError}
        onSignIn={() => void signIn()}
      />
    );
  }

  return (
    <WorkspaceShell
      key={account.homeAccountId}
      {...(accessTokenProvider === undefined ? {} : { accessTokenProvider })}
      identityLabel={account.name ?? account.username ?? account.homeAccountId}
      signingOut={signingOut}
      onSignOut={() => void signOut()}
      {...(authError === undefined
        ? {}
        : {
            authenticationError: authError,
            onDismissAuthenticationError: () => setAuthError(undefined),
          })}
    />
  );
}

function EntraSignIn({
  busy,
  error,
  onSignIn,
}: {
  readonly busy: boolean;
  readonly error: string | undefined;
  readonly onSignIn: () => void;
}) {
  return (
    <AuthenticationFrame>
      <div className="rounded-2xl border border-[#252d3a] bg-[#0d121a] p-5 shadow-2xl shadow-black/30">
        <div className="grid size-11 place-items-center rounded-xl border border-[#36554b] bg-[#10251e] text-[#78e6bd]">
          <LockKeyhole size={21} aria-hidden="true" />
        </div>
        <h1 className="mt-5 text-2xl font-semibold tracking-tight">Sign in to Atoms</h1>
        <p className="mt-2 text-sm leading-6 text-[#98a5b7]">
          Continue with the secure Microsoft Entra External ID sign-in experience.
        </p>

        {error !== undefined ? (
          <div
            className="mt-4 rounded-xl border border-[#67333a] bg-[#1c1014] px-3 py-2 text-sm text-[#ff9ca6]"
            role="alert"
          >
            {error}
          </div>
        ) : null}

        <button
          className="mt-6 inline-flex w-full items-center justify-center gap-2 rounded-xl bg-[#78e6bd] px-4 py-3 text-sm font-bold text-[#06281e] disabled:cursor-not-allowed disabled:opacity-55"
          type="button"
          disabled={busy}
          onClick={onSignIn}
        >
          {busy ? (
            <LoaderCircle className="animate-spin" size={17} />
          ) : (
            <LogIn size={17} />
          )}
          {busy ? "Opening sign-in…" : "Continue with Microsoft"}
        </button>
        <p className="mt-4 text-xs leading-5 text-[#718095]">
          Microsoft Entra handles sign-up, sign-in, session renewal, and account
          recovery. Workspace authorization remains enforced by the Atoms Control API.
        </p>
      </div>
    </AuthenticationFrame>
  );
}

function AuthenticationFrame({ children }: { readonly children: ReactNode }) {
  return (
    <main className="grid min-h-screen place-items-center px-4 py-10">
      <div className="w-full max-w-md">
        <div className="mb-5 flex items-center justify-center gap-3">
          <div className="grid size-9 place-items-center rounded-xl border border-[#36554b] bg-[#10251e] text-[#78e6bd]">
            <GitBranch size={18} aria-hidden="true" />
          </div>
          <div>
            <p className="font-semibold tracking-tight">Atoms</p>
            <p className="text-xs text-[#7f8b9d]">Secure agent workspace</p>
          </div>
        </div>
        {children}
      </div>
    </main>
  );
}
