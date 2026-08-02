import { createHmac, timingSafeEqual } from "node:crypto";

import { z } from "zod";

const BaseDomainSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(3)
  .max(253)
  .regex(
    /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/,
    "baseDomain must be a DNS name",
  );
const SessionIdSchema = z.string().uuid();
const SignatureSchema = z.string().regex(/^[a-f0-9]{48}$/);
const ExpiryLabelSchema = z.string().regex(/^[a-z0-9]{1,16}$/);

export interface PreviewTicketSignerOptions {
  readonly secret: string;
  readonly baseDomain: string;
  readonly publicProtocol?: "http" | "https";
  readonly now?: () => Date;
}

export interface VerifiedPreviewTicket {
  readonly sessionId: string;
  readonly expiresAt: string;
}

export class PreviewTicketError extends Error {
  override readonly name = "PreviewTicketError";
  readonly code:
    | "INVALID_HOST"
    | "INVALID_SIGNATURE"
    | "EXPIRED_TICKET";

  constructor(
    code: PreviewTicketError["code"],
    message = "Invalid preview ticket",
  ) {
    super(message);
    this.code = code;
  }
}

export class PreviewTicketSigner {
  readonly #secret: string;
  readonly #baseDomain: string;
  readonly #protocol: "http" | "https";
  readonly #now: () => Date;

  constructor(options: PreviewTicketSignerOptions) {
    if (Buffer.byteLength(options.secret, "utf8") < 32) {
      throw new TypeError("Preview signing secret must contain at least 32 bytes");
    }
    this.#secret = options.secret;
    this.#baseDomain = BaseDomainSchema.parse(options.baseDomain);
    this.#protocol = options.publicProtocol ?? "https";
    this.#now = options.now ?? (() => new Date());
  }

  issue(sessionId: string, expiresAt: Date): string {
    const normalizedSessionId = SessionIdSchema.parse(sessionId);
    if (expiresAt.getTime() <= this.#now().getTime()) {
      throw new PreviewTicketError(
        "EXPIRED_TICKET",
        "Preview expiry must be in the future",
      );
    }
    const sessionLabel = normalizedSessionId.replaceAll("-", "");
    const expiryLabel = expiresAt.getTime().toString(36);
    const signature = this.#signature(normalizedSessionId, expiryLabel);
    return `${this.#protocol}://${sessionLabel}.${expiryLabel}.${signature}.${this.#baseDomain}/`;
  }

  verifyHost(untrustedHost: string): VerifiedPreviewTicket {
    const host = untrustedHost.trim().toLowerCase().replace(/:\d+$/, "");
    const suffix = `.${this.#baseDomain}`;
    if (!host.endsWith(suffix)) {
      throw new PreviewTicketError("INVALID_HOST");
    }
    const ticketLabels = host.slice(0, -suffix.length).split(".");
    if (ticketLabels.length !== 3) {
      throw new PreviewTicketError("INVALID_HOST");
    }
    const [sessionLabel, expiryCandidate, signatureCandidate] = ticketLabels;
    if (
      sessionLabel === undefined ||
      !/^[a-f0-9]{32}$/.test(sessionLabel) ||
      expiryCandidate === undefined ||
      signatureCandidate === undefined
    ) {
      throw new PreviewTicketError("INVALID_HOST");
    }
    const expiryLabel = ExpiryLabelSchema.safeParse(expiryCandidate);
    const signature = SignatureSchema.safeParse(signatureCandidate);
    if (!expiryLabel.success || !signature.success) {
      throw new PreviewTicketError("INVALID_HOST");
    }
    const sessionId = [
      sessionLabel.slice(0, 8),
      sessionLabel.slice(8, 12),
      sessionLabel.slice(12, 16),
      sessionLabel.slice(16, 20),
      sessionLabel.slice(20),
    ].join("-");
    SessionIdSchema.parse(sessionId);
    const expected = this.#signature(sessionId, expiryLabel.data);
    const expectedBytes = Buffer.from(expected, "utf8");
    const actualBytes = Buffer.from(signature.data, "utf8");
    if (
      expectedBytes.length !== actualBytes.length ||
      !timingSafeEqual(expectedBytes, actualBytes)
    ) {
      throw new PreviewTicketError("INVALID_SIGNATURE");
    }
    const expiresAtMs = Number.parseInt(expiryLabel.data, 36);
    if (!Number.isSafeInteger(expiresAtMs) || expiresAtMs <= this.#now().getTime()) {
      throw new PreviewTicketError("EXPIRED_TICKET", "Preview ticket expired");
    }
    return {
      sessionId,
      expiresAt: new Date(expiresAtMs).toISOString(),
    };
  }

  #signature(sessionId: string, expiryLabel: string): string {
    return createHmac("sha256", this.#secret)
      .update(`${sessionId}.${expiryLabel}.${this.#baseDomain}`)
      .digest("hex")
      .slice(0, 48);
  }
}

