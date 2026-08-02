import { randomUUID } from "node:crypto";
import test from "node:test";

import {
  InMemorySecretStore,
  SupabaseDatabaseProvider,
} from "./index.js";

const enabled =
  process.env.RUN_LIVE_SUPABASE_TESTS === "true" &&
  process.env.SUPABASE_LIVE_DESTRUCTIVE_CONFIRMATION ===
    "PROVISION_AND_DESTROY_SUPABASE_STAGING_DATABASE" &&
  typeof process.env.SUPABASE_ACCESS_TOKEN === "string" &&
  process.env.SUPABASE_ACCESS_TOKEN.length > 0 &&
  typeof process.env.SUPABASE_ORGANIZATION_SLUG === "string" &&
  process.env.SUPABASE_ORGANIZATION_SLUG.length > 0;

test(
  "live Supabase smoke provisions, reaches health, and destroys a generated database",
  {
    skip: enabled
      ? false
      : "requires explicit live-test opt-in, Supabase credentials, and exact destructive confirmation; this can be billable",
    timeout: 10 * 60_000,
  },
  async () => {
    const secretStore = new InMemorySecretStore();
    const provider = new SupabaseDatabaseProvider({
      accessToken: process.env.SUPABASE_ACCESS_TOKEN as string,
      organizationSlug: process.env.SUPABASE_ORGANIZATION_SLUG as string,
      secretStore,
    });
    const operationId = randomUUID();
    let externalId: string | undefined;
    let connectionSecretRef: string | undefined;
    try {
      const result = await provider.provision({
        operationId,
        projectId: randomUUID(),
        displayName: "Atoms live provider smoke",
        region: "americas",
      });
      externalId = result.externalId;
      connectionSecretRef = result.connectionSecretRef;
      for (let attempt = 0; attempt < 60; attempt += 1) {
        const health = await provider.getHealth(result.externalId);
        if (health.state === "HEALTHY") return;
        if (health.state === "UNHEALTHY") {
          throw new Error("Live Supabase project reported unhealthy services");
        }
        await new Promise((resolve) => setTimeout(resolve, 5_000));
      }
      throw new Error("Live Supabase project did not become healthy in five minutes");
    } finally {
      if (externalId !== undefined) {
        await provider.destroy(externalId, connectionSecretRef);
      }
    }
  },
);
