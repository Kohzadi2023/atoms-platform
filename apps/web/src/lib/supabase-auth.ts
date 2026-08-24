import type { ControlApiAccessTokenProvider } from "./control-api.js";

export interface SupabaseBrowserConfiguration {
  readonly url: string;
  readonly publishableKey: string;
}

export type BrowserAuthenticationMode =
  | {
      readonly kind: "supabase";
      readonly configuration: SupabaseBrowserConfiguration;
    }
  | { readonly kind: "development" }
  | { readonly kind: "configuration_error"; readonly message: string };

export interface SupabaseSessionReader {
  readonly auth: {
    getSession(): Promise<{
      readonly data: {
        readonly session: { readonly access_token: string } | null;
      };
      readonly error: { readonly message: string } | null;
    }>;
  };
}

export function resolveBrowserAuthenticationMode(input: {
  readonly nodeEnv: string | undefined;
  readonly supabaseUrl: string | undefined;
  readonly supabasePublishableKey: string | undefined;
}): BrowserAuthenticationMode {
  const url = normalizedOptionalValue(input.supabaseUrl);
  const publishableKey = normalizedOptionalValue(input.supabasePublishableKey);

  if (url !== undefined && publishableKey !== undefined) {
    const validatedUrl = validateSupabaseUrl(url);
    if (validatedUrl === null) {
      return {
        kind: "configuration_error",
        message:
          "NEXT_PUBLIC_SUPABASE_URL must be an HTTPS project URL (HTTP is allowed only for localhost).",
      };
    }
    if (publishableKey.length < 20) {
      return {
        kind: "configuration_error",
        message: "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY is not valid.",
      };
    }
    return {
      kind: "supabase",
      configuration: { url: validatedUrl, publishableKey },
    };
  }

  if (url !== undefined || publishableKey !== undefined) {
    return {
      kind: "configuration_error",
      message:
        "NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY must be configured together.",
    };
  }

  if (input.nodeEnv === "development") {
    return { kind: "development" };
  }

  return {
    kind: "configuration_error",
    message:
      "Supabase Auth is required outside development. Configure NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY.",
  };
}

export function createSupabaseAccessTokenProvider(
  client: SupabaseSessionReader,
): ControlApiAccessTokenProvider {
  return async () => {
    const { data, error } = await client.auth.getSession();
    if (error !== null) {
      throw new Error("The Supabase session could not be loaded", {
        cause: error,
      });
    }
    const accessToken = data.session?.access_token.trim();
    return accessToken === undefined || accessToken.length === 0
      ? undefined
      : accessToken;
  };
}

function normalizedOptionalValue(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized === undefined || normalized.length === 0
    ? undefined
    : normalized;
}

function validateSupabaseUrl(value: string): string | null {
  try {
    const url = new URL(value);
    const localHost =
      url.hostname === "localhost" ||
      url.hostname === "127.0.0.1" ||
      url.hostname === "[::1]";
    if (url.protocol !== "https:" && !(localHost && url.protocol === "http:")) {
      return null;
    }
    if (
      url.username.length > 0 ||
      url.password.length > 0 ||
      url.search.length > 0 ||
      url.hash.length > 0 ||
      (url.pathname !== "/" && url.pathname !== "")
    ) {
      return null;
    }
    return url.origin;
  } catch {
    return null;
  }
}
