import type { ControlApiAccessTokenProvider } from "./control-api.js";

export function createDevelopmentAccessTokenProvider(options: {
  readonly nodeEnv: string | undefined;
  readonly configuredToken: string | undefined;
}): ControlApiAccessTokenProvider {
  const configuredToken = options.configuredToken?.trim();

  if (options.nodeEnv === "production" && configuredToken !== undefined) {
    throw new Error(
      "NEXT_PUBLIC_CONTROL_API_ACCESS_TOKEN is development-only and cannot be used in production",
    );
  }

  if (options.nodeEnv !== "development" || configuredToken === undefined) {
    return () => undefined;
  }

  return () => configuredToken;
}
