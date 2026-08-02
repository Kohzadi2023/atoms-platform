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
    const response = await this.#gateway.generate({
      policy: manifest.policy,
      instructions: `${manifest.objective}\n\n${manifest.instructions}\n\nRequired JSON shape: ${manifest.schemaHint}`,
      input: JSON.stringify({
        userPrompt: request.prompt,
        upstreamOutputs: request.upstreamOutputs,
        currentFiles: request.currentFiles,
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
      metadata: {
        run_id: request.runId,
        agent: request.agentName,
        manifest_version: manifest.version,
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
      throw new AgentRuntimeError(
        `Agent ${request.agentName} returned invalid JSON`,
        {
          code: "INVALID_AGENT_OUTPUT",
          retryable: false,
          cause: error,
        },
      );
    }

    const parsed = manifest.outputSchema.safeParse(value);
    if (!parsed.success) {
      throw new AgentRuntimeError(
        `Agent ${request.agentName} output failed schema validation`,
        {
          code: "INVALID_AGENT_OUTPUT",
          retryable: false,
          cause: parsed.error,
        },
      );
    }
    return parsed.data;
  }
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
