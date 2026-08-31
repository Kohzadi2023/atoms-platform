export interface ContentSecurityPolicyOptions {
  readonly controlApiUrl: string;
  readonly supabaseUrl?: string;
  readonly storageUrl?: string;
  readonly previewBaseDomain?: string;
}

export function buildContentSecurityPolicy(
  options: ContentSecurityPolicyOptions,
): string {
  const controlApiOrigin = httpOrigin(
    options.controlApiUrl,
    "NEXT_PUBLIC_CONTROL_API_URL",
  );
  const supabaseOrigin = optionalHttpOrigin(
    options.supabaseUrl,
    "NEXT_PUBLIC_SUPABASE_URL",
  );
  const storageOrigin = optionalHttpOrigin(
    options.storageUrl,
    "NEXT_PUBLIC_STORAGE_ORIGIN",
  );
  const previewBaseDomain = normalizePreviewBaseDomain(
    options.previewBaseDomain ?? "preview.localhost",
  );
  const localPreviewSources = previewBaseDomain.endsWith(".localhost")
    ? ` http://${previewBaseDomain}:* http://*.${previewBaseDomain}:*`
    : "";
  const connectSources = [
    "'self'",
    controlApiOrigin,
    supabaseOrigin,
    storageOrigin,
  ].filter((value): value is string => value !== undefined);

  return [
    "default-src 'self'",
    "base-uri 'none'",
    `connect-src ${connectSources.join(" ")}`,
    `frame-src https://${previewBaseDomain} https://*.${previewBaseDomain}${localPreviewSources}`,
    "frame-ancestors 'self'",
    "form-action 'self'",
    "img-src 'self' data: blob:",
    "object-src 'none'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'",
    "worker-src 'self' blob:",
  ].join("; ");
}

export function normalizePreviewBaseDomain(value: string): string {
  const normalized = value.trim().toLowerCase().replace(/^\.+|\.+$/gu, "");
  return /^[a-z0-9.-]+$/u.test(normalized)
    ? normalized
    : "preview.localhost";
}

function optionalHttpOrigin(
  value: string | undefined,
  name: string,
): string | undefined {
  if (value === undefined || value.trim().length === 0) return undefined;
  return httpOrigin(value, name);
}

function httpOrigin(value: string, name: string): string {
  const url = new URL(value);
  const localHost =
    url.hostname === "localhost" ||
    url.hostname === "127.0.0.1" ||
    url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(localHost && url.protocol === "http:")) {
    throw new Error(`${name} must use HTTPS outside local development`);
  }
  return url.origin;
}
