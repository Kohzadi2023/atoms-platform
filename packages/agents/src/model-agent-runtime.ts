import type { ModelGateway } from "@atoms/model-gateway";

import { AgentRuntimeError } from "./errors.js";
import { getAgentManifest } from "./manifests.js";
import type {
  ActiveAgentName,
  AgentExecutionRequest,
  AgentOutputByName,
  AgentRuntime,
} from "./schemas.js";

export class ModelBackedAgentRuntime implements AgentRuntime {
  readonly #gateway: ModelGateway;

  constructor(gateway: ModelGateway) {
    this.#gateway = gateway;
  }

  async execute<Name extends ActiveAgentName>(
    request: AgentExecutionRequest<Name>,
  ): Promise<AgentOutputByName[Name]> {
    const manifest = getAgentManifest(request.agentName);
    // Fail closed: untrusted references only reach agents whose instructions
    // carry the reference contract.
    if (
      !manifest.acceptsReferences &&
      request.referenceAttachments !== undefined &&
      request.referenceAttachments.length > 0
    ) {
      throw new AgentRuntimeError(
        `Agent ${request.agentName} does not accept reference attachments`,
        { code: "REFERENCES_NOT_ACCEPTED", retryable: false },
      );
    }
    // Models routinely slip on a cross-field rule the schema enforces (a
    // destructive change that points at a non-destructive migration, say). The
    // precise issues are the best possible hint, so a schema failure gets one
    // correction pass with those issues before the agent -- and the run -- fails.
    let correctionIssues: readonly string[] | undefined;
    for (let correction = 0; ; correction += 1) {
      const response = await this.#gateway.generate({
        policy: manifest.policy,
        instructions: `${manifest.objective}\n\n${manifest.instructions}\n\nRequired JSON shape: ${manifest.schemaHint}`,
        input: JSON.stringify({
          userPrompt: request.prompt,
          upstreamOutputs: request.upstreamOutputs,
          currentFiles: request.currentFiles,
          ...(correctionIssues === undefined
            ? {}
            : {
                previousResponseFailedValidation: correctionIssues,
                correctionInstruction:
                  "Your previous response failed schema validation with the issues listed in previousResponseFailedValidation. Return the complete corrected JSON object, fixing every issue and changing nothing else.",
              }),
        }),
        ...(request.referenceAttachments === undefined ||
        request.referenceAttachments.length === 0
          ? {}
          : {
              references: request.referenceAttachments.map((attachment) =>
                attachment.kind === "file"
                  ? {
                      kind: "file" as const,
                      fileName: attachment.fileName,
                      mimeType: attachment.mimeType,
                      dataBase64: attachment.dataBase64,
                    }
                  : {
                      kind: "image" as const,
                      fileName: attachment.fileName,
                      mimeType: attachment.mimeType,
                      dataBase64: attachment.dataBase64,
                    },
              ),
            }),
        maxOutputTokens: manifest.maxOutputTokens,
        responseFormat: "json",
        metadata: {
          run_id: request.runId,
          agent: request.agentName,
          manifest_version: manifest.version,
          ...(correction === 0 ? {} : { correction: String(correction) }),
        },
      });

      if (response.status !== "completed") {
        throw new AgentRuntimeError(
          `Agent ${request.agentName} model response ended with ${response.status}`,
          {
            code: "MODEL_RESPONSE_INCOMPLETE",
            retryable:
              response.status === "in_progress" || response.status === "queued",
          },
        );
      }

      let value: unknown;
      try {
        value = JSON.parse(extractJsonObject(response.outputText));
      } catch (error) {
        // A completed (not truncated) response that is not valid JSON is a
        // formatting slip, typically an unescaped newline inside a long string.
        // It gets the same single correction pass as a schema failure.
        if (correction >= MAX_SCHEMA_CORRECTIONS) {
          throw new AgentRuntimeError(
            `Agent ${request.agentName} returned invalid JSON`,
            {
              code: "INVALID_AGENT_OUTPUT",
              retryable: false,
              cause: error,
            },
          );
        }
        correctionIssues = [
          `The response was not a valid JSON object: ${
            error instanceof Error ? error.message : "parse failure"
          }. Return exactly one JSON object with every string correctly escaped (newlines as \\n, quotes as \\").`.slice(
            0,
            MAX_ISSUE_LENGTH,
          ),
        ];
        continue;
      }

      const parsed = manifest.outputSchema.safeParse(value);
      if (parsed.success) return parsed.data;
      if (correction >= MAX_SCHEMA_CORRECTIONS) {
        throw new AgentRuntimeError(
          `Agent ${request.agentName} output failed schema validation`,
          {
            code: "INVALID_AGENT_OUTPUT",
            retryable: false,
            cause: parsed.error,
          },
        );
      }
      correctionIssues = summarizeSchemaIssues(parsed.error.issues);
    }
  }
}

const MAX_SCHEMA_CORRECTIONS = 1;
const MAX_REPORTED_ISSUES = 20;
const MAX_ISSUE_LENGTH = 300;

function summarizeSchemaIssues(
  issues: ReadonlyArray<{ readonly path: ReadonlyArray<PropertyKey>; readonly message: string }>,
): readonly string[] {
  return issues.slice(0, MAX_REPORTED_ISSUES).map((issue) =>
    `${issue.path.map(String).join(".") || "(root)"}: ${issue.message}`.slice(
      0,
      MAX_ISSUE_LENGTH,
    ),
  );
}

function extractJsonObject(output: string): string {
  const trimmed = output.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    return trimmed;
  }
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start < 0 || end <= start) {
    throw new SyntaxError("No JSON object found in model output");
  }
  return trimmed.slice(start, end + 1);
}
