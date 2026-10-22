import { readFileSync } from "node:fs";

import type { NextConfig } from "next";

import { buildContentSecurityPolicy } from "./src/lib/content-security-policy";

const contentSecurityPolicy = buildContentSecurityPolicy({
  controlApiUrl:
    process.env.NEXT_PUBLIC_CONTROL_API_URL ?? "http://localhost:3001",
  ...(process.env.NEXT_PUBLIC_ENTRA_AUTHORITY === undefined
    ? {}
    : { identityAuthorityUrl: process.env.NEXT_PUBLIC_ENTRA_AUTHORITY }),
  ...(process.env.NEXT_PUBLIC_STORAGE_ORIGIN === undefined
    ? {}
    : { storageUrl: process.env.NEXT_PUBLIC_STORAGE_ORIGIN }),
  ...(process.env.NEXT_PUBLIC_PREVIEW_BASE_DOMAIN === undefined
    ? {}
    : { previewBaseDomain: process.env.NEXT_PUBLIC_PREVIEW_BASE_DOMAIN }),
});

const sharedSecurityHeaders = [
  { key: "Content-Security-Policy", value: contentSecurityPolicy },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
  { key: "Referrer-Policy", value: "no-referrer" },
  { key: "X-Content-Type-Options", value: "nosniff" },
];

// One product version for every merge. It lives in the repository root package.json,
// CI requires each pull request to raise it, and the footer shows it.
const rootPackage = JSON.parse(
  readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
) as { version?: unknown };
const appVersion =
  typeof rootPackage.version === "string" ? rootPackage.version : "";

const nextConfig: NextConfig = {
  output: "standalone",
  env: { NEXT_PUBLIC_APP_VERSION: appVersion },
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
        headers: sharedSecurityHeaders,
      },
      {
        source: "/((?!redirect$)(?!redirect/).*)",
        headers: [
          { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
        ],
      },
    ];
  },
};

export default nextConfig;
