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
const TicketLabelSchema = z
  .string()
  .length(61)
  .regex(/^[a-z0-9]{25}-[a-z0-9]{9}-[a-z0-9]{25}$/);

const BASE36_SESSION_WIDTH = 25;
const BASE36_EXPIRY_WIDTH = 9;
const BASE36_MAC_WIDTH = 25;
const MAC_BYTES = 16;
const MAX_UUID_VALUE = (1n << 128n) - 1n;

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
    if (!Number.isSafeInteger(expiresAt.getTime())) {
      throw new PreviewTicketError("INVALID_HOST", "Preview expiry is out of range");
    }

    const sessionLabel = encodeUuidBase36(normalizedSessionId);
    const expiryLabel = BigInt(expiresAt.getTime())
      .toString(36)
      .padStart(BASE36_EXPIRY_WIDTH, "0");
    if (expiryLabel.length !== BASE36_EXPIRY_WIDTH) {
      throw new PreviewTicketError("INVALID_HOST", "Preview expiry is out of range");
    }
    const signature = this.#signature(normalizedSessionId, expiryLabel);
    const ticketLabel = `${sessionLabel}-${expiryLabel}-${signature}`;
    TicketLabelSchema.parse(ticketLabel);
    return `${this.#protocol}://${ticketLabel}.${this.#baseDomain}/`;
  }

  verifyHost(untrustedHost: string): VerifiedPreviewTicket {
    const host = untrustedHost.trim().toLowerCase().replace(/:\d+$/, "");
    const suffix = `.${this.#baseDomain}`;
    if (!host.endsWith(suffix)) {
      throw new PreviewTicketError("INVALID_HOST");
    }

    const ticketLabel = host.slice(0, -suffix.length);
    const parsedTicket = TicketLabelSchema.safeParse(ticketLabel);
    if (!parsedTicket.success) {
      throw new PreviewTicketError("INVALID_HOST");
    }
    const [sessionCandidate, expiryCandidate, signatureCandidate] =
      parsedTicket.data.split("-");
    if (
      sessionCandidate === undefined ||
      expiryCandidate === undefined ||
      signatureCandidate === undefined
    ) {
      throw new PreviewTicketError("INVALID_HOST");
    }

    let sessionId: string;
    let expiresAtMs: number;
    try {
      sessionId = decodeUuidBase36(sessionCandidate);
      expiresAtMs = Number(parseBase36(expiryCandidate));
    } catch {
      throw new PreviewTicketError("INVALID_HOST");
    }
    if (!Number.isSafeInteger(expiresAtMs)) {
      throw new PreviewTicketError("INVALID_HOST");
    }

    const expected = this.#signature(sessionId, expiryCandidate);
    const expectedBytes = Buffer.from(expected, "utf8");
    const actualBytes = Buffer.from(signatureCandidate, "utf8");
    if (
      expectedBytes.length !== actualBytes.length ||
      !timingSafeEqual(expectedBytes, actualBytes)
    ) {
      throw new PreviewTicketError("INVALID_SIGNATURE");
    }
    if (expiresAtMs <= this.#now().getTime()) {
      throw new PreviewTicketError("EXPIRED_TICKET", "Preview ticket expired");
    }
    return {
      sessionId,
      expiresAt: new Date(expiresAtMs).toISOString(),
    };
  }

  #signature(sessionId: string, expiryLabel: string): string {
    const mac = createHmac("sha256", this.#secret)
      .update(`${sessionId}.${expiryLabel}.${this.#baseDomain}`)
      .digest()
      .subarray(0, MAC_BYTES);
    return bytesToBigInt(mac).toString(36).padStart(BASE36_MAC_WIDTH, "0");
  }
}

function encodeUuidBase36(sessionId: string): string {
  const hex = sessionId.replaceAll("-", "");
  const value = BigInt(`0x${hex}`);
  return value.toString(36).padStart(BASE36_SESSION_WIDTH, "0");
}

function decodeUuidBase36(value: string): string {
  const numeric = parseBase36(value);
  if (numeric < 0n || numeric > MAX_UUID_VALUE) {
    throw new RangeError("UUID token is out of range");
  }
  const hex = numeric.toString(16).padStart(32, "0");
  const sessionId = [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join("-");
  return SessionIdSchema.parse(sessionId);
}

function parseBase36(value: string): bigint {
  let result = 0n;
  for (const character of value) {
    const code = character.charCodeAt(0);
    let digit: number;
    if (code >= 48 && code <= 57) {
      digit = code - 48;
    } else if (code >= 97 && code <= 122) {
      digit = code - 87;
    } else {
      throw new TypeError("Invalid base36 character");
    }
    if (digit >= 36) throw new TypeError("Invalid base36 character");
    result = result * 36n + BigInt(digit);
  }
  return result;
}

function bytesToBigInt(value: Uint8Array): bigint {
  let result = 0n;
  for (const byte of value) {
    result = (result << 8n) | BigInt(byte);
  }
  return result;
}
