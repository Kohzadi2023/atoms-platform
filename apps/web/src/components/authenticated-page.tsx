"use client";

import {
  InteractionRequiredAuthError,
  PublicClientApplication,
  type AccountInfo,
  type IPublicClientApplication,
} from "@azure/msal-browser";
import { AlertTriangle, LoaderCircle, LockKeyhole, LogIn } from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";

import { createDevelopmentAccessTokenProvider } from "../lib/browser-auth";
import type { ControlApiAccessTokenProvider } from "../lib/control-api";
import {
  createEntraAccessTokenProvider,
  createEntraRedirectUri,
  resolveBrowserAuthenticationMode,
  type EntraBrowserConfiguration,
} from "../lib/entra-auth";

export interface AuthenticatedSession {
  readonly accessTokenProvider: ControlApiAccessTokenProvider;
  readonly identityLabel: string;
  readonly signingOut: boolean;
  readonly onSignOut?: () => void;
}

interface AuthenticatedPageProps {
  readonly title: string;
  readonly signInPrompt: string;
  readonly children: (session: AuthenticatedSession) => ReactNode;
}

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

/**
 * Same sign-in behaviour as the other pages (development token locally, Microsoft
 * Entra External ID elsewhere), exposed as a render prop so a page only supplies
 * what it shows once a Control API access token exists.
 */
export function AuthenticatedPage({ title, signInPrompt, children }: AuthenticatedPageProps) {
  if (authenticationMode.kind === "development") {
    return (
      <>
        {children({
          accessTokenProvider: DEVELOPMENT_ACCESS_TOKEN_PROVIDER,
          identityLabel: "Development auth",
          signingOut: false,
        })}
      </>
    );
  }

  if (authenticationMode.kind === "configuration_error") {
    return (
      <Frame>
        <div className="rounded-2xl border border-[#67333a] bg-[#1c1014] p-5" role="alert">
          <AlertTriangle className="text-[#ff8a96]" size={24} aria-hidden="true" />
          <h1 className="mt-4 text-xl font-semibold">Authentication is not configured</h1>
          <p className="mt-2 text-sm leading-6 text-[#c3a7ad]">{authenticationMode.message}</p>
        </div>
      </Frame>
    );
  }

  return (
    <EntraBoundary
      configuration={authenticationMode.configuration}
      title={title}
      signInPrompt={signInPrompt}
    >
      {children}
    </EntraBoundary>
  );
}

function EntraBoundary({
  configuration,
  title,
  signInPrompt,
  children,
}: AuthenticatedPageProps & { readonly configuration: EntraBrowserConfiguration }) {
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
      console.error("Failed to initialize Microsoft Entra authentication", error);
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
      console.error("Failed to start Microsoft Entra sign-in", error);
      setAuthError("Sign-in could not be started. Please try again.");
    }
  }

  async function signOut() {
    if (client === undefined || account === undefined || account === null) return;
    setSigningOut(true);
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
    return <Loading label="Restoring your secure session…" />;
  }

  if (account === null) {
    return (
      <Frame>
        <div className="rounded-2xl border border-[#252d3a] bg-[#0d121a] p-5 shadow-2xl shadow-black/30">
          <div className="grid size-11 place-items-center rounded-xl border border-[#36554b] bg-[#10251e] text-[#78e6bd]">
            <LockKeyhole size={21} aria-hidden="true" />
          </div>
          <h1 className="mt-5 text-2xl font-semibold tracking-tight">{title}</h1>
          <p className="mt-2 text-sm leading-6 text-[#98a5b7]">{signInPrompt}</p>
          {authError !== undefined ? (
            <div
              className="mt-4 rounded-xl border border-[#67333a] bg-[#1c1014] px-3 py-2 text-sm text-[#ff9ca6]"
              role="alert"
            >
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
      </Frame>
    );
  }

  if (accessTokenProvider === undefined) {
    return <Loading label="Preparing Control API access…" />;
  }

  return (
    <>
      {children({
        accessTokenProvider,
        identityLabel: account.name ?? account.username ?? account.homeAccountId,
        signingOut,
        onSignOut: () => void signOut(),
      })}
    </>
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
  return (
    <main className="grid min-h-screen place-items-center px-4 py-10 text-white">
      <div className="w-full max-w-md">{children}</div>
    </main>
  );
}
