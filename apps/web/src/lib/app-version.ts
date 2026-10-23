const VERSION = /^\d+\.\d+\.\d+$/u;

/** Text for the page footer; falls back to "dev" when no valid build version was injected. */
export function formatAppVersion(raw: string | undefined): string {
  const value = raw?.trim() ?? "";
  return VERSION.test(value) ? `Atoms v${value}` : "Atoms dev";
}
