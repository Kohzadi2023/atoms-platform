import { once } from "node:events";

import {
  PreviewTicketSigner,
  RedisPreviewSessionStore,
} from "@atoms/preview";
import { z } from "zod";

import { buildPreviewGateway } from "./gateway.js";

const EnvironmentSchema = z
  .object({
    REDIS_URL: z.string().url(),
    PREVIEW_SIGNING_SECRET: z.string().min(32),
    PREVIEW_BASE_DOMAIN: z.string().min(3),
    PREVIEW_UI_ORIGIN: z.string().url(),
    PREVIEW_PUBLIC_PROTOCOL: z.enum(["http", "https"]).default("https"),
    PREVIEW_GATEWAY_HOST: z.string().min(1).default("0.0.0.0"),
    PREVIEW_GATEWAY_PORT: z.coerce
      .number()
      .int()
      .min(1)
      .max(65_535)
      .default(3_002),
  })
  .passthrough();

async function main(): Promise<void> {
  const environment = EnvironmentSchema.parse(process.env);
  const store = new RedisPreviewSessionStore({ redisUrl: environment.REDIS_URL });
  const signer = new PreviewTicketSigner({
    secret: environment.PREVIEW_SIGNING_SECRET,
    baseDomain: environment.PREVIEW_BASE_DOMAIN,
    publicProtocol: environment.PREVIEW_PUBLIC_PROTOCOL,
  });
  const server = buildPreviewGateway({
    signer,
    store,
    uiOrigin: environment.PREVIEW_UI_ORIGIN,
    onError: (error) => console.error("Preview gateway error", error),
  });
  server.listen(environment.PREVIEW_GATEWAY_PORT, environment.PREVIEW_GATEWAY_HOST);
  await once(server, "listening");

  let shuttingDown = false;
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    server.close();
    await once(server, "close");
    await store.close();
  };
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});

