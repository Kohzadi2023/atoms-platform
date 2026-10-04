/**
 * Compares the routes Bob planned with the files Alex actually generated.
 *
 * A live run shipped a middleware that sent signed-out visitors to NextAuth's
 * default sign-in page while the planned `/api/auth/[...nextauth]` handler was
 * never written, so the delivered preview opened on a 404. That gap is
 * deterministic to detect from file paths alone, before any sandbox is paid for.
 */

export const ROUTE_COVERAGE_STEP = "route-coverage";

export interface PlannedRoute {
  readonly method: string;
  readonly path: string;
}

const SOURCE_EXTENSION = /\.(?:tsx|ts|jsx|js|mjs)$/u;

/** Dynamic segment names differ freely ([id] vs [accountId]); only their shape matters. */
export function normalizeRoutePath(path: string): string {
  const withoutQuery = path.split(/[?#]/u)[0] ?? "";
  const segments = withoutQuery
    .split("/")
    .filter((segment) => segment.length > 0)
    .map((segment) => {
      if (/^\[\[\.\.\.[^\]]+\]\]$/u.test(segment)) return "[[...]]";
      if (/^\[\.\.\.[^\]]+\]$/u.test(segment)) return "[...]";
      if (/^\[[^\]]+\]$/u.test(segment)) return "[]";
      if (/^:[A-Za-z0-9_]+$/u.test(segment) || /^\{[^}]+\}$/u.test(segment)) {
        return "[]";
      }
      return segment;
    });
  return `/${segments.join("/")}`;
}

/** The route a generated file serves, or undefined when the file is not a route entry. */
export function routeServedByFile(filePath: string): string | undefined {
  const path = filePath.replace(/^src\//u, "");
  const segments = path.split("/");
  const fileName = segments.at(-1) ?? "";

  if (segments[0] === "app") {
    if (!/^(?:page|route)\.(?:tsx|ts|jsx|js|mjs)$/u.test(fileName)) return undefined;
    const directories = segments
      .slice(1, -1)
      .filter((segment) => !/^\(.*\)$/u.test(segment) && !segment.startsWith("@"));
    return normalizeRoutePath(directories.join("/"));
  }

  if (segments[0] === "pages") {
    if (!SOURCE_EXTENSION.test(fileName)) return undefined;
    const base = fileName.replace(SOURCE_EXTENSION, "");
    if (base.startsWith("_")) return undefined;
    const directories = segments.slice(1, -1);
    return normalizeRoutePath([...directories, ...(base === "index" ? [] : [base])].join("/"));
  }

  return undefined;
}

/**
 * Planned routes with no file serving them. Judges nothing for a project that has
 * neither an app/ nor a pages/ directory, since file-based routing is the premise.
 */
export function findMissingRoutes(
  planned: readonly PlannedRoute[],
  filePaths: readonly string[],
): readonly PlannedRoute[] {
  const usesFileRouting = filePaths.some((path) => {
    const trimmed = path.replace(/^src\//u, "");
    return trimmed.startsWith("app/") || trimmed.startsWith("pages/");
  });
  if (!usesFileRouting) return [];

  const served = new Set<string>();
  for (const filePath of filePaths) {
    const route = routeServedByFile(filePath);
    if (route !== undefined) served.add(route);
  }

  const missing: PlannedRoute[] = [];
  const seen = new Set<string>();
  for (const route of planned) {
    if (!route.path.startsWith("/")) continue;
    const normalized = normalizeRoutePath(route.path);
    if (served.has(normalized) || seen.has(normalized)) continue;
    seen.add(normalized);
    missing.push(route);
  }
  return missing;
}

export function describeMissingRoutes(missing: readonly PlannedRoute[]): string {
  return missing.map((route) => `${route.method} ${route.path}`).join("\n");
}
