import { createHash } from "node:crypto";

import type { AttachmentMimeType } from "@atoms/contracts";

export function calculateSha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function detectAttachmentMimeType(
  bytes: Uint8Array,
): AttachmentMimeType | null {
  if (startsWith(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d])) {
    return "application/pdf";
  }
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return "image/png";
  }
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (
    startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) &&
    bytes.byteLength >= 12 &&
    startsWith(bytes.subarray(8), [0x57, 0x45, 0x42, 0x50])
  ) {
    return "image/webp";
  }
  return isPlainText(bytes) ? "text/plain" : null;
}

function startsWith(bytes: Uint8Array, prefix: readonly number[]): boolean {
  return (
    bytes.byteLength >= prefix.length &&
    prefix.every((value, index) => bytes[index] === value)
  );
}

function isPlainText(bytes: Uint8Array): boolean {
  if (bytes.byteLength === 0 || bytes.includes(0)) return false;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    for (const character of text) {
      const codePoint = character.codePointAt(0) ?? 0;
      if (codePoint < 32 && ![9, 10, 12, 13].includes(codePoint)) return false;
    }
    return true;
  } catch {
    return false;
  }
}
