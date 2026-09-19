import { SandboxNetworkPolicySchema } from "@atoms/sandbox-provider";

const IPV4_LITERAL = /^\d{1,3}(?:\.\d{1,3}){3}$/;

/**
 * Parses E2B_ALLOWED_HOSTS into the exact hostnames the sandbox may reach.
 * The list is operator configuration and nothing generated or user-supplied
 * feeds it. It must stay an exact-hostname allowlist: a wildcard, an IP literal
 * or a single-label name would widen egress beyond the package registries, so
 * they are refused at startup instead of being passed on to the provider.
 */
export function parseEgressAllowedHosts(raw: string): readonly string[] {
  const hosts = [
    ...new Set(
      raw
        .split(",")
        .map((host) => host.trim().toLowerCase())
        .filter((host) => host.length > 0),
    ),
  ];

  for (const host of hosts) {
    if (host.includes("*")) {
      throw new RangeError(
        `E2B_ALLOWED_HOSTS must list exact hostnames; wildcard "${host}" is not allowed`,
      );
    }
    if (IPV4_LITERAL.test(host)) {
      throw new RangeError(
        `E2B_ALLOWED_HOSTS must list hostnames; IP address "${host}" is not allowed`,
      );
    }
    if (!host.includes(".")) {
      throw new RangeError(
        `E2B_ALLOWED_HOSTS entry "${host}" is not a fully qualified hostname`,
      );
    }
  }

  const parsed = SandboxNetworkPolicySchema.safeParse({
    allowedHosts: hosts,
    allowPublicTraffic: false,
  });
  if (!parsed.success) {
    throw new RangeError(
      `E2B_ALLOWED_HOSTS is not a valid hostname list: ${parsed.error.issues
        .map((issue) => issue.message)
        .join("; ")}`,
    );
  }
  return parsed.data.allowedHosts;
}
