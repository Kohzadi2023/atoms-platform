import { formatAppVersion } from "../lib/app-version";

export function AppVersionFooter() {
  return (
    <footer
      aria-label="Application version"
      className="pointer-events-none fixed inset-x-0 bottom-1 z-10 text-center font-mono text-[10px] text-[#6f7d90]"
    >
      {formatAppVersion(process.env.NEXT_PUBLIC_APP_VERSION)}
    </footer>
  );
}
