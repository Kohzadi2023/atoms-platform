import {
  ContentPackageSchema,
  ProjectFilePathSchema,
  SeoPackageSchema,
} from "@atoms/contracts";
import { z } from "zod";

export const ActiveAgentNameSchema = z.enum([
  "Mike",
  "Emma",
  "Bob",
  "Alex",
  "David",
  "Sarah",
  "Adrian",
]);

export type ActiveAgentName = z.infer<typeof ActiveAgentNameSchema>;

/** @deprecated Use ActiveAgentName. Retained for Checkpoint 2 consumers. */
export const ActiveMvpAgentNameSchema = ActiveAgentNameSchema;
/** @deprecated Use ActiveAgentName. Retained for Checkpoint 2 consumers. */
export type ActiveMvpAgentName = ActiveAgentName;

const BoundedTextSchema = z.string().trim().min(1).max(20_000);
const ShortTextSchema = z.string().trim().min(1).max(2_000);

export const MikeOutputSchema = z
  .object({
    summary: BoundedTextSchema,
    taskGraph: z
      .array(
        z
          .object({
            key: z.string().regex(/^[a-z][a-z0-9-]{1,79}$/),
            agent: ActiveAgentNameSchema,
            description: ShortTextSchema,
            dependsOn: z.array(z.string().min(1).max(80)).max(10),
            acceptanceCriteria: z.array(ShortTextSchema).min(1).max(20),
            maxAttempts: z.number().int().min(1).max(3),
          })
          .strict(),
      )
      .min(1)
      .max(30),
    assumptions: z.array(ShortTextSchema).max(30),
    requiresApproval: z.boolean(),
  })
  .strict();

export type MikeOutput = z.infer<typeof MikeOutputSchema>;

export const EmmaOutputSchema = z
  .object({
    productName: z.string().trim().min(1).max(160),
    problemStatement: BoundedTextSchema,
    targetUsers: z.array(ShortTextSchema).min(1).max(20),
    userStories: z
      .array(
        z
          .object({
            id: z.string().regex(/^US-[0-9]{3}$/),
            role: ShortTextSchema,
            goal: ShortTextSchema,
            benefit: ShortTextSchema,
            acceptanceCriteria: z.array(ShortTextSchema).min(1).max(20),
          })
          .strict(),
      )
      .min(1)
      .max(50),
    nonGoals: z.array(ShortTextSchema).max(30),
    assumptions: z.array(ShortTextSchema).max(30),
  })
  .strict();

export type EmmaOutput = z.infer<typeof EmmaOutputSchema>;

export const BobOutputSchema = z
  .object({
    architectureSummary: BoundedTextSchema,
    routes: z
      .array(
        z
          .object({
            method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
            path: z.string().trim().min(1).max(1_024),
            purpose: ShortTextSchema,
          })
          .strict(),
      )
      .max(100),
    components: z.array(ShortTextSchema).min(1).max(100),
    dataModels: z.array(ShortTextSchema).max(100),
    schemaPrisma: z.string().min(1).max(500_000),
    decisions: z.array(ShortTextSchema).min(1).max(50),
  })
  .strict();

export type BobOutput = z.infer<typeof BobOutputSchema>;

export const AgentGeneratedFileSchema = z
  .object({
    path: ProjectFilePathSchema,
    content: z.string().max(2_000_000),
    /** Zero creates a new path; a positive value is the observed latest version. */
    expectedVersion: z.number().int().nonnegative(),
  })
  .strict();

export type AgentGeneratedFile = z.infer<typeof AgentGeneratedFileSchema>;

/** @deprecated AgentGeneratedFile is shared by Alex and David. */
export const AlexGeneratedFileSchema = AgentGeneratedFileSchema;
/** @deprecated AgentGeneratedFile is shared by Alex and David. */
export type AlexGeneratedFile = AgentGeneratedFile;

const AgentGeneratedFilesSchema = z
  .array(AgentGeneratedFileSchema)
  .min(1)
  .max(200)
  .superRefine((files, context) => {
    const seen = new Set<string>();
    files.forEach((file, index) => {
      if (seen.has(file.path)) {
        context.addIssue({
          code: "custom",
          path: [index, "path"],
          message: "generated file paths must be unique",
        });
      }
      seen.add(file.path);
    });
  });

export const AlexOutputSchema = z
  .object({
    summary: BoundedTextSchema,
    files: AgentGeneratedFilesSchema,
    commands: z
      .object({
        lint: z.string().trim().min(1).max(1_000),
        typecheck: z.string().trim().min(1).max(1_000),
        test: z.string().trim().min(1).max(1_000),
        build: z.string().trim().min(1).max(1_000),
      })
      .strict(),
  })
  .strict();

export type AlexOutput = z.infer<typeof AlexOutputSchema>;

export const DavidMigrationSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(1)
      .max(120)
      .regex(/^[a-z0-9]+(?:_[a-z0-9]+)*$/),
    path: ProjectFilePathSchema.refine(
      (value) => /^prisma\/migrations\/[^/]+\/migration\.sql$/.test(value),
      "migration path must use prisma/migrations/<name>/migration.sql",
    ),
    risk: z.enum(["SAFE", "DESTRUCTIVE"]),
    rationale: ShortTextSchema,
  })
  .strict();

export const DavidOutputSchema = z
  .object({
    summary: BoundedTextSchema,
    schemaPrismaPath: ProjectFilePathSchema,
    migrations: z.array(DavidMigrationSchema).min(1).max(50),
    seedPath: ProjectFilePathSchema,
    files: AgentGeneratedFilesSchema,
    dataPolicyReport: z
      .object({
        summary: BoundedTextSchema,
        rlsModels: z.array(z.string().trim().min(1).max(160)).max(100),
        findings: z
          .array(
            z
              .object({
                severity: z.enum(["INFO", "WARNING", "BLOCKING"]),
                subject: ShortTextSchema,
                recommendation: ShortTextSchema,
              })
              .strict(),
          )
          .max(100),
      })
      .strict(),
    destructiveChanges: z
      .array(
        z
          .object({
            migrationPath: ProjectFilePathSchema,
            description: ShortTextSchema,
          })
          .strict(),
      )
      .max(50),
  })
  .strict()
  .superRefine((output, context) => {
    const generatedPaths = new Set(output.files.map((file) => file.path));
    const migrationPaths = new Set<string>();
    for (const [index, migration] of output.migrations.entries()) {
      if (migrationPaths.has(migration.path)) {
        context.addIssue({
          code: "custom",
          path: ["migrations", index, "path"],
          message: "migration paths must be unique",
        });
      }
      migrationPaths.add(migration.path);
      if (!generatedPaths.has(migration.path)) {
        context.addIssue({
          code: "custom",
          path: ["migrations", index, "path"],
          message: "every migration path must be included in files",
        });
      }
    }
    if (!generatedPaths.has(output.seedPath)) {
      context.addIssue({
        code: "custom",
        path: ["seedPath"],
        message: "seedPath must be included in files",
      });
    }
    const destructivePaths = new Set(
      output.destructiveChanges.map((change) => change.migrationPath),
    );
    for (const [index, migration] of output.migrations.entries()) {
      if (
        migration.risk === "DESTRUCTIVE" &&
        !destructivePaths.has(migration.path)
      ) {
        context.addIssue({
          code: "custom",
          path: ["migrations", index, "risk"],
          message: "destructive migrations must be disclosed",
        });
      }
    }
    for (const [index, change] of output.destructiveChanges.entries()) {
      const migration = output.migrations.find(
        (candidate) => candidate.path === change.migrationPath,
      );
      if (migration?.risk !== "DESTRUCTIVE") {
        context.addIssue({
          code: "custom",
          path: ["destructiveChanges", index, "migrationPath"],
          message: "destructive change must reference a destructive migration",
        });
      }
    }
  });

export type DavidOutput = z.infer<typeof DavidOutputSchema>;

export const SarahOutputSchema = z
  .object({
    summary: BoundedTextSchema,
    seoPackage: SeoPackageSchema,
  })
  .strict();

export type SarahOutput = z.infer<typeof SarahOutputSchema>;

export const AdrianOutputSchema = z
  .object({
    summary: BoundedTextSchema,
    contentPackage: ContentPackageSchema,
  })
  .strict();

export type AdrianOutput = z.infer<typeof AdrianOutputSchema>;

export interface AgentOutputByName {
  readonly Mike: MikeOutput;
  readonly Emma: EmmaOutput;
  readonly Bob: BobOutput;
  readonly Alex: AlexOutput;
  readonly David: DavidOutput;
  readonly Sarah: SarahOutput;
  readonly Adrian: AdrianOutput;
}

export const AgentOutputSchemas = {
  Mike: MikeOutputSchema,
  Emma: EmmaOutputSchema,
  Bob: BobOutputSchema,
  Alex: AlexOutputSchema,
  David: DavidOutputSchema,
  Sarah: SarahOutputSchema,
  Adrian: AdrianOutputSchema,
} as const;

export interface AgentProjectFile {
  readonly path: string;
  readonly content: string;
  readonly version: number;
}

export type AgentReferenceAttachment =
  | {
      readonly id: string;
      readonly kind: "file";
      readonly fileName: string;
      readonly mimeType: "application/pdf" | "text/plain";
      readonly dataBase64: string;
    }
  | {
      readonly id: string;
      readonly kind: "image";
      readonly fileName: string;
      readonly mimeType: "image/png" | "image/jpeg" | "image/webp";
      readonly dataBase64: string;
    };

export type AgentUpstreamOutputs = Partial<{
  readonly [Name in ActiveAgentName]: AgentOutputByName[Name];
}>;

export interface AgentExecutionRequest<
  Name extends ActiveAgentName = ActiveAgentName,
> {
  readonly agentName: Name;
  readonly runId: string;
  readonly prompt: string;
  readonly upstreamOutputs: AgentUpstreamOutputs;
  readonly currentFiles: readonly AgentProjectFile[];
  /** Clean, immutable reference inputs. The orchestrator sends them only to Emma. */
  readonly referenceAttachments?: readonly AgentReferenceAttachment[];
}

export interface AgentRuntime {
  execute<Name extends ActiveAgentName>(
    request: AgentExecutionRequest<Name>,
  ): Promise<AgentOutputByName[Name]>;
}
