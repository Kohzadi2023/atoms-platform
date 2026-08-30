import type { NextConfig } from "next";

import { buildContentSecurityPolicy } from "./src/lib/content-security-policy";

const contentSecurityPolicy = buildContentSecurityPolicy({
  controlApiUrl:
    process.env.NEXT_PUBLIC_CONTROL_API_URL ?? "http://localhost:3001",
  ...(process.env.NEXT_PUBLIC_SUPABASE_URL === undefined
    ? {}
    : { supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL }),
  ...(process.env.NEXT_PUBLIC_STORAGE_ORIGIN === undefined
    ? {}
    : { storageUrl: process.env.NEXT_PUBLIC_STORAGE_ORIGIN }),
  ...(process.env.NEXT_PUBLIC_PREVIEW_BASE_DOMAIN === undefined
    ? {}
    : { previewBaseDomain: process.env.NEXT_PUBLIC_PREVIEW_BASE_DOMAIN }),
});

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
