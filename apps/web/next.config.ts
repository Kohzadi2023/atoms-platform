import type { NextConfig } from "next";

const controlApiOrigin = new URL(
  process.env.NEXT_PUBLIC_CONTROL_API_URL ?? "http://localhost:3001",
).origin;
const supabaseOrigin = optionalHttpsOrigin(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
);
const previewBaseDomain = normalizeDomain(
  process.env.NEXT_PUBLIC_PREVIEW_BASE_DOMAIN ?? "preview.localhost",
);
const localPreviewSources = previewBaseDomain.endsWith(".localhost")
  ? ` http://${previewBaseDomain}:* http://*.${previewBaseDomain}:*`
  : "";
const contentSecurityPolicy = [
  "default-src 'self'",
  "base-uri 'none'",
  `connect-src 'self' ${controlApiOrigin}${supabaseOrigin === undefined ? "" : ` ${supabaseOrigin}`}`,
  `frame-src https://${previewBaseDomain} https://*.${previewBaseDomain}${localPreviewSources}`,
  "frame-ancestors 'self'",
  "form-action 'self'",
  "img-src 'self' data: blob:",
  "object-src 'none'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "worker-src 'self' blob:",
].join("; ");

const nextConfig: NextConfig = {
  output: "standalone",
  poweredByHeader: false,
  reactStrictMode: true,
  transpilePackages: ["@atoms/contracts"],
  experimental: {
    useTypeScriptCli: true,
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "Content-Security-Policy", value: contentSecurityPolicy },
          { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "X-Content-Type-Options", value: "nosniff" },
        ],
      },
    ];
  },
};

export default nextConfig;

function normalizeDomain(value: string): string {
  const normalized = value.trim().toLowerCase().replace(/^\.+|\.+$/gu, "");
  return /^[a-z0-9.-]+$/u.test(normalized) ? normalized : "preview.localhost";
}

function optionalHttpsOrigin(value: string | undefined): string | undefined {
  if (value === undefined || value.trim().length === 0) return undefined;
  const url = new URL(value);
  const localHost =
    url.hostname === "localhost" ||
    url.hostname === "127.0.0.1" ||
    url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(localHost && url.protocol === "http:")) {
    throw new Error(
      "NEXT_PUBLIC_SUPABASE_URL must use HTTPS outside local development",
    );
  }
  return url.origin;
}
