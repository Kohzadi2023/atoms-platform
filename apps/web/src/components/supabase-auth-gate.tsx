"use client";

import { createBrowserClient } from "@supabase/ssr";
import type { Session } from "@supabase/supabase-js";
import {
  AlertTriangle,
  GitBranch,
  LoaderCircle,
  LockKeyhole,
  LogIn,
} from "lucide-react";
import {
  useEffect,
  useMemo,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";

import {
  createSupabaseAccessTokenProvider,
  resolveBrowserAuthenticationMode,
  type SupabaseBrowserConfiguration,
} from "../lib/supabase-auth";
import { WorkspaceShell } from "./workspace-shell";

const authenticationMode = resolveBrowserAuthenticationMode({
  nodeEnv: process.env.NODE_ENV,
  supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL,
  supabasePublishableKey:
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
});
const ACTIVE_RUN_STORAGE_KEY = "atoms.active-run.v1";

export function SupabaseAuthGate() {
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
            The production workspace remains unavailable until both public Supabase
            settings are provided.
          </p>
        </div>
      </AuthenticationFrame>
    );
  }
  return (
    <SupabaseSessionBoundary configuration={authenticationMode.configuration} />
  );
}

function SupabaseSessionBoundary({
  configuration,
}: {
  readonly configuration: SupabaseBrowserConfiguration;
}) {
  const [client] = useState(() =>
    createBrowserClient(configuration.url, configuration.publishableKey),
  );
  const [session, setSession] = useState<Session | null | undefined>(undefined);
  const [authError, setAuthError] = useState<string | undefined>();
  const [signingOut, setSigningOut] = useState(false);
  const accessTokenProvider = useMemo(
    () => createSupabaseAccessTokenProvider(client),
    [client],
  );

  useEffect(() => {
    let active = true;
    const {
      data: { subscription },
    } = client.auth.onAuthStateChange((_event, nextSession) => {
      if (!active) return;
      // This gates only the browser experience. The Control API independently
      // verifies the JWT signature, claims, and workspace membership.
      if (nextSession === null) {
        globalThis.localStorage.removeItem(ACTIVE_RUN_STORAGE_KEY);
      }
      setSession(nextSession);
      setAuthError(undefined);
    });

    void client.auth
      .getSession()
      .then(({ data, error }) => {
        if (!active) return;
        if (error !== null) {
          setAuthError("The saved Supabase session could not be restored.");
          setSession(null);
          return;
        }
        setSession(data.session);
      })
      .catch(() => {
        if (!active) return;
        setAuthError("Supabase Auth is temporarily unavailable.");
        setSession(null);
      });

    return () => {
      active = false;
      subscription.unsubscribe();
    };
  }, [client]);

  async function signOut() {
    setSigningOut(true);
    setAuthError(undefined);
    try {
      const { error } = await client.auth.signOut({ scope: "local" });
      if (error !== null) throw error;
      globalThis.localStorage.removeItem(ACTIVE_RUN_STORAGE_KEY);
      setSession(null);
    } catch {
      setAuthError("Sign-out failed. Please try again.");
    } finally {
      setSigningOut(false);
    }
  }

  if (session === undefined) {
    return (
      <AuthenticationFrame>
        <div className="flex items-center justify-center gap-3 rounded-2xl border border-[#252d3a] bg-[#0d121a] p-8 text-sm text-[#aab5c5]">
          <LoaderCircle className="animate-spin text-[#78e6bd]" size={20} />
          Restoring your secure session…
        </div>
      </AuthenticationFrame>
    );
  }

  if (session === null) {
    return (
      <SupabaseSignIn
        client={client}
        initialError={authError}
        onAuthenticated={setSession}
      />
    );
  }

  return (
    <WorkspaceShell
      key={session.user.id}
      accessTokenProvider={accessTokenProvider}
      identityLabel={session.user.email ?? session.user.id}
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

function SupabaseSignIn({
  client,
  initialError,
  onAuthenticated,
}: {
  readonly client: ReturnType<typeof createBrowserClient>;
  readonly initialError: string | undefined;
  readonly onAuthenticated: (session: Session) => void;
}) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(initialError);

  useEffect(() => {
    if (initialError !== undefined) setError(initialError);
  }, [initialError]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      const result = await client.auth.signInWithPassword({
        email: email.trim(),
        password,
      });
      if (result.error !== null) {
        setError(result.error.message);
        return;
      }
      if (result.data.session === null) {
        setError("Supabase did not create an authenticated session.");
        return;
      }
      onAuthenticated(result.data.session);
      setPassword("");
    } catch {
      setError("Supabase Auth is temporarily unavailable.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthenticationFrame>
      <form
        className="rounded-2xl border border-[#252d3a] bg-[#0d121a] p-5 shadow-2xl shadow-black/30"
        onSubmit={submit}
      >
        <div className="grid size-11 place-items-center rounded-xl border border-[#36554b] bg-[#10251e] text-[#78e6bd]">
          <LockKeyhole size={21} aria-hidden="true" />
        </div>
        <h1 className="mt-5 text-2xl font-semibold tracking-tight">Sign in to Atoms</h1>
        <p className="mt-2 text-sm leading-6 text-[#98a5b7]">
          Use the Supabase account invited to an Atoms workspace.
        </p>

        <label className="mt-6 block text-sm font-medium text-[#c8d1de]">
          Email
          <input
            className={inputClass}
            type="email"
            value={email}
            autoComplete="email"
            inputMode="email"
            required
            disabled={busy}
            onChange={(event) => setEmail(event.target.value)}
          />
        </label>
        <label className="mt-4 block text-sm font-medium text-[#c8d1de]">
          Password
          <input
            className={inputClass}
            type="password"
            value={password}
            autoComplete="current-password"
            required
            disabled={busy}
            onChange={(event) => setPassword(event.target.value)}
          />
        </label>

        {error !== undefined ? (
          <div
            className="mt-4 rounded-xl border border-[#67333a] bg-[#1c1014] px-3 py-2 text-sm text-[#ff9ca6]"
            role="alert"
          >
            {error}
          </div>
        ) : null}

        <button
          className="mt-5 inline-flex w-full items-center justify-center gap-2 rounded-xl bg-[#78e6bd] px-4 py-3 text-sm font-bold text-[#06281e] disabled:cursor-not-allowed disabled:opacity-55"
          type="submit"
          disabled={busy}
        >
          {busy ? (
            <LoaderCircle className="animate-spin" size={17} />
          ) : (
            <LogIn size={17} />
          )}
          {busy ? "Signing in…" : "Sign in"}
        </button>
        <p className="mt-4 text-xs leading-5 text-[#718095]">
          Access is invite-only. Authentication is handled by Supabase; workspace
          roles are enforced separately by the Control API.
        </p>
      </form>
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

const inputClass =
  "mt-2 w-full rounded-xl border border-[#2a3442] bg-[#090d13] px-3 py-2.5 text-sm text-[#e2e8f0] placeholder:text-[#657184] disabled:cursor-not-allowed disabled:opacity-60";
