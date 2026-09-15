export const PHASE3_MAX_BUDGET_MICROS = 4_000_000;
export const PHASE3_COST_CONFIRMATION = "I_ATTEST_ACTUAL_PHASE3_COST_AFTER_CLEANUP";

export function parseCadMicros(value) {
  if (typeof value !== "string" || !/^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/.test(value)) {
    throw new Error("CAD amount must be a non-negative decimal with at most six decimals");
  }
  const [whole, fraction = ""] = value.split(".");
  const micros = BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, "0"));
  if (micros > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("CAD amount is outside the supported range");
  return Number(micros);
}

export function parseApprovedBudget(value) {
  const micros = parseCadMicros(value);
  if (micros <= 0 || micros > PHASE3_MAX_BUDGET_MICROS) {
    throw new Error("Approved budget must be positive and at most CAD 4");
  }
  return micros;
}
