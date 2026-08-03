import { z } from "zod";

const ShortTextSchema = z.string().trim().min(1).max(500);
const LongTextSchema = z.string().trim().min(1).max(20_000);

export const SeoPackageVersionSchema = z.literal("v1");
export type SeoPackageVersion = z.infer<typeof SeoPackageVersionSchema>;

export const SeoFindingSeveritySchema = z.enum(["INFO", "WARNING", "BLOCKING"]);
export type SeoFindingSeverity = z.infer<typeof SeoFindingSeveritySchema>;

export const SeoRouteMetadataSchema = z
  .object({
    routePath: z.string().trim().min(1).max(1_024),
    title: z.string().trim().min(1).max(120),
    description: z.string().trim().min(1).max(320),
    canonicalUrl: z.string().url().max(2_048).nullable(),
  })
  .strict();
export type SeoRouteMetadata = z.infer<typeof SeoRouteMetadataSchema>;

export const SeoFindingSchema = z
  .object({
    severity: SeoFindingSeveritySchema,
    subject: ShortTextSchema,
    recommendation: ShortTextSchema,
  })
  .strict();
export type SeoFinding = z.infer<typeof SeoFindingSchema>;

export const SeoPackageSchema = z
  .object({
    version: SeoPackageVersionSchema,
    sitemapXml: z.string().trim().min(1).max(2_000_000),
    robotsTxt: z.string().trim().min(1).max(20_000),
    routeMetadata: z.array(SeoRouteMetadataSchema).min(1).max(500),
    findings: z.array(SeoFindingSchema).max(200),
  })
  .strict()
  .superRefine((value, context) => {
    const seenRoutes = new Set<string>();
    value.routeMetadata.forEach((item, index) => {
      if (seenRoutes.has(item.routePath)) {
        context.addIssue({
          code: "custom",
          path: ["routeMetadata", index, "routePath"],
          message: "route paths must be unique",
        });
      }
      seenRoutes.add(item.routePath);
    });
  });
export type SeoPackage = z.infer<typeof SeoPackageSchema>;

export const ContentPackageVersionSchema = z.literal("v1");
export type ContentPackageVersion = z.infer<typeof ContentPackageVersionSchema>;

export const ContentAdChannelSchema = z.enum([
  "SEARCH",
  "SOCIAL",
  "DISPLAY",
  "EMAIL",
]);
export type ContentAdChannel = z.infer<typeof ContentAdChannelSchema>;

export const ContentCtaVariantSchema = z
  .object({
    id: z.string().trim().min(1).max(80),
    headline: z.string().trim().min(1).max(160),
    body: LongTextSchema,
    ctaLabel: z.string().trim().min(1).max(80),
  })
  .strict();
export type ContentCtaVariant = z.infer<typeof ContentCtaVariantSchema>;

export const ContentAdVariantSchema = z
  .object({
    channel: ContentAdChannelSchema,
    headline: z.string().trim().min(1).max(120),
    body: LongTextSchema,
    ctaLabel: z.string().trim().min(1).max(80).nullable(),
  })
  .strict();
export type ContentAdVariant = z.infer<typeof ContentAdVariantSchema>;

export const EvidenceRequirementStatusSchema = z.enum(["REQUIRED", "PROVIDED"]);
export type EvidenceRequirementStatus = z.infer<
  typeof EvidenceRequirementStatusSchema
>;

export const ClaimEvidenceRequirementSchema = z
  .object({
    claim: LongTextSchema,
    evidenceStatus: EvidenceRequirementStatusSchema,
    notes: ShortTextSchema.nullable(),
  })
  .strict();
export type ClaimEvidenceRequirement = z.infer<
  typeof ClaimEvidenceRequirementSchema
>;

export const ContentPackageSchema = z
  .object({
    version: ContentPackageVersionSchema,
    audience: ShortTextSchema,
    valuePropositions: z.array(ShortTextSchema).min(1).max(20),
    ctaVariants: z.array(ContentCtaVariantSchema).min(1).max(100),
    adVariants: z.array(ContentAdVariantSchema).max(100),
    claimsRequiringEvidence: z
      .array(ClaimEvidenceRequirementSchema)
      .max(200),
  })
  .strict()
  .superRefine((value, context) => {
    const seenIds = new Set<string>();
    value.ctaVariants.forEach((variant, index) => {
      if (seenIds.has(variant.id)) {
        context.addIssue({
          code: "custom",
          path: ["ctaVariants", index, "id"],
          message: "cta variant ids must be unique",
        });
      }
      seenIds.add(variant.id);
    });
  });
export type ContentPackage = z.infer<typeof ContentPackageSchema>;
