import type { ModelPolicy } from "@atoms/model-gateway";
import type { z } from "zod";

import {
  AgentOutputSchemas,
  type ActiveAgentName,
  type AgentOutputByName,
} from "./schemas.js";

export interface AgentManifest<Name extends ActiveAgentName> {
  readonly name: Name;
  readonly version: string;
  readonly objective: string;
  readonly instructions: string;
  readonly schemaHint: string;
  readonly policy: ModelPolicy;
  readonly maxOutputTokens: number;
  readonly outputSchema: z.ZodType<AgentOutputByName[Name]>;
}

export type AgentManifestMap = {
  readonly [Name in ActiveAgentName]: AgentManifest<Name>;
};

const sharedRules = [
  "Return exactly one JSON object and no Markdown fences.",
  "Do not invent credentials, provider state, test results, or completed deployments.",
  "Stay inside Next.js, React, TypeScript, Tailwind, Prisma, and PostgreSQL.",
].join(" ");

export const agentManifests: AgentManifestMap = {
  Mike: {
    name: "Mike",
    version: "1.0.0",
    objective: "Create an auditable dependency graph and identify approval points.",
    instructions: `${sharedRules} Every task must have an owner, dependencies, acceptance criteria, and a retry budget of at most three attempts.`,
    schemaHint:
      '{"summary":string,"taskGraph":[{"key":kebab-case,"agent":"Mike|Emma|Bob|Alex|David|Sarah|Adrian","description":string,"dependsOn":string[],"acceptanceCriteria":string[],"maxAttempts":1|2|3}],"assumptions":string[],"requiresApproval":boolean}',
    policy: "balanced",
    maxOutputTokens: 4_000,
    outputSchema: AgentOutputSchemas.Mike,
  },
  Emma: {
    name: "Emma",
    version: "1.0.0",
    objective: "Turn the request into bounded product requirements and acceptance criteria.",
    instructions: `${sharedRules} Resolve the supported PoC scope, make assumptions explicit, and use sequential story IDs such as US-001.`,
    schemaHint:
      '{"productName":string,"problemStatement":string,"targetUsers":string[],"userStories":[{"id":"US-001","role":string,"goal":string,"benefit":string,"acceptanceCriteria":string[]}],"nonGoals":string[],"assumptions":string[]}',
    policy: "flagship",
    maxOutputTokens: 6_000,
    outputSchema: AgentOutputSchemas.Emma,
  },
  Bob: {
    name: "Bob",
    version: "1.0.0",
    objective: "Produce supported architecture, routes, components, data models, and Prisma schema.",
    instructions: `${sharedRules} Map every accepted story to the architecture and keep the result implementable as one generated Next.js repository.`,
    schemaHint:
      '{"architectureSummary":string,"routes":[{"method":"GET|POST|PUT|PATCH|DELETE","path":string,"purpose":string}],"components":string[],"dataModels":string[],"schemaPrisma":string,"decisions":string[]}',
    policy: "flagship",
    maxOutputTokens: 10_000,
    outputSchema: AgentOutputSchemas.Bob,
  },
  Alex: {
    name: "Alex",
    version: "1.0.0",
    objective: "Generate a coherent, testable Next.js project without overwriting unseen edits.",
    instructions: `${sharedRules} Return complete file contents. For each path, echo the exact observed version in expectedVersion; use zero only for a new path. Include deterministic lint, typecheck, test, and build commands.`,
    schemaHint:
      '{"summary":string,"files":[{"path":relative-posix-path,"content":string,"expectedVersion":nonnegative-integer}],"commands":{"lint":string,"typecheck":string,"test":string,"build":string}}',
    policy: "flagship",
    maxOutputTokens: 32_000,
    outputSchema: AgentOutputSchemas.Alex,
  },
  David: {
    name: "David",
    version: "1.0.0",
    objective:
      "Review the Prisma data model and produce forward-only migrations, idempotent seed data, and a data-policy report.",
    instructions: `${sharedRules} Never include a credential or connection string. Emit Prisma migration files under prisma/migrations/<timestamp_name>/migration.sql and an idempotent seed file. Disclose every destructive statement. Do not generate down migrations. For each file, echo the exact observed version and use zero only for a new path.`,
    schemaHint:
      '{"summary":string,"schemaPrismaPath":relative-posix-path,"migrations":[{"name":snake_case,"path":"prisma/migrations/<name>/migration.sql","risk":"SAFE|DESTRUCTIVE","rationale":string}],"seedPath":relative-posix-path,"files":[{"path":relative-posix-path,"content":string,"expectedVersion":nonnegative-integer}],"dataPolicyReport":{"summary":string,"rlsModels":string[],"findings":[{"severity":"INFO|WARNING|BLOCKING","subject":string,"recommendation":string}]},"destructiveChanges":[{"migrationPath":relative-posix-path,"description":string}]}',
    policy: "flagship",
    maxOutputTokens: 20_000,
    outputSchema: AgentOutputSchemas.David,
  },
  Sarah: {
    name: "Sarah",
    version: "1.0.0",
    objective:
      "Produce route-aware technical SEO artifacts with deterministic findings.",
    instructions: `${sharedRules} Do not fabricate rankings or traffic claims. Keep findings tied to concrete route metadata coverage and canonical rules.`,
    schemaHint:
      '{"summary":string,"seoPackage":{"version":"v1","sitemapXml":string,"robotsTxt":string,"routeMetadata":[{"routePath":string,"title":string,"description":string,"canonicalUrl":string|null}],"findings":[{"severity":"INFO|WARNING|BLOCKING","subject":string,"recommendation":string}]}}',
    policy: "balanced",
    maxOutputTokens: 8_000,
    outputSchema: AgentOutputSchemas.Sarah,
  },
  Adrian: {
    name: "Adrian",
    version: "1.0.0",
    objective:
      "Produce audience-aligned growth copy variants with explicit evidence requirements.",
    instructions: `${sharedRules} Keep copy aligned to approved audience and value proposition. Flag every factual claim that requires evidence instead of inventing proof.`,
    schemaHint:
      '{"summary":string,"contentPackage":{"version":"v1","audience":string,"valuePropositions":string[],"ctaVariants":[{"id":string,"headline":string,"body":string,"ctaLabel":string}],"adVariants":[{"channel":"SEARCH|SOCIAL|DISPLAY|EMAIL","headline":string,"body":string,"ctaLabel":string|null}],"claimsRequiringEvidence":[{"claim":string,"evidenceStatus":"REQUIRED|PROVIDED","notes":string|null}]}}',
    policy: "balanced",
    maxOutputTokens: 8_000,
    outputSchema: AgentOutputSchemas.Adrian,
  },
};

export function getAgentManifest<Name extends ActiveAgentName>(
  name: Name,
): AgentManifestMap[Name] {
  return agentManifests[name];
}
