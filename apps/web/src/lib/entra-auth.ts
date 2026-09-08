import type { ControlApiAccessTokenProvider } from "./control-api.js";

export interface EntraBrowserConfiguration {
  readonly clientId: string;
  readonly authority: string;
  readonly knownAuthority: string;
  readonly apiScope: string;
}

export type BrowserAuthenticationMode =
  | {
      readonly kind: "entra";
      readonly configuration: EntraBrowserConfiguration;
    }
  | { readonly kind: "development" }
  | { readonly kind: "configuration_error"; readonly message: string };

export interface EntraAccountLike {
  readonly homeAccountId: string;
}

export interface EntraSilentTokenClient {
  acquireTokenSilent(request: {
    readonly account: EntraAccountLike;
    readonly scopes: readonly string[];
  }): Promise<{ readonly accessToken: string }>;
}

export function resolveBrowserAuthenticationMode(input: {
  readonly nodeEnv: string | undefined;
  readonly clientId: string | undefined;
  readonly authority: string | undefined;
  readonly apiScope: string | undefined;
}): BrowserAuthenticationMode {
  const clientId = normalizedOptionalValue(input.clientId);
  const authority = normalizedOptionalValue(input.authority);
  const apiScope = normalizedOptionalValue(input.apiScope);

  if (clientId !== undefined && authority !== undefined && apiScope !== undefined) {
    if (!isGuid(clientId)) {
      return {
        kind: "configuration_error",
        message: "NEXT_PUBLIC_ENTRA_CLIENT_ID must be an Application (client) ID GUID.",
      };
    }

    const normalizedAuthority = validateAuthority(authority);
    if (normalizedAuthority === null) {
      return {
        kind: "configuration_error",
        message: "NEXT_PUBLIC_ENTRA_AUTHORITY must be an HTTPS Microsoft Entra authority URL.",
      };
    }

    if (!apiScope.startsWith("api://") || !apiScope.includes("/")) {
      return {
        kind: "configuration_error",
        message: "NEXT_PUBLIC_ENTRA_API_SCOPE must be a delegated API scope such as api://<api-client-id>/access_as_user.",
      };
    }

    return {
      kind: "entra",
      configuration: {
        clientId,
        authority: normalizedAuthority.href,
        knownAuthority: normalizedAuthority.hostname,
        apiScope,
      },
    };
  }

  if (clientId !== undefined || authority !== undefined || apiScope !== undefined) {
    return {
      kind: "configuration_error",
      message:
        "NEXT_PUBLIC_ENTRA_CLIENT_ID, NEXT_PUBLIC_ENTRA_AUTHORITY, and NEXT_PUBLIC_ENTRA_API_SCOPE must be configured together.",
    };
  }

  if (input.nodeEnv === "development") {
    return { kind: "development" };
  }

  return {
    kind: "configuration_error",
    message:
      "Microsoft Entra External ID is required outside development. Configure the public Entra client ID, authority, and Control API delegated scope.",
  };
}

export function createEntraAccessTokenProvider(
  client: EntraSilentTokenClient,
  account: EntraAccountLike,
  apiScope: string,
): ControlApiAccessTokenProvider {
  return async () => {
    const result = await client.acquireTokenSilent({
      account,
      scopes: [apiScope],
    });
    const token = result.accessToken.trim();
    return token.length === 0 ? undefined : token;
  };
}

function normalizedOptionalValue(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized === undefined || normalized.length === 0
    ? undefined
    : normalized;
}

function isGuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
    value,
  );
}

function validateAuthority(value: string): URL | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") return null;
    if (
      url.username.length > 0 ||
      url.password.length > 0 ||
      url.search.length > 0 ||
      url.hash.length > 0
    ) {
      return null;
    }
    if (!url.hostname.endsWith(".ciamlogin.com")) return null;
    url.pathname = url.pathname === "/" ? "/" : url.pathname.replace(/\/+$/u, "") + "/";
    return url;
  } catch {
    return null;
  }
}
