// Read-only check of the certificate the public Preview Gateway serves (issue #93).
//
//   node scripts/check-preview-cert-expiry.mjs [--host <name>] [--min-days 30]
//
// The wildcard certificate for *.preview.genesisco.io is a Let's Encrypt certificate
// with no automatic renewal, so something has to notice before it expires. This opens
// one TLS connection to a name under the wildcard and reads the certificate the server
// presents. It sends no request and needs no credentials.
//
// Exit codes: 0 valid for at least --min-days, 1 too close to expiry / expired /
// not trusted for the host, 2 the check itself could not run.

import { connect } from "node:tls";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const DEFAULT_HOST = "cert-expiry-check.preview.genesisco.io";
export const DEFAULT_MIN_DAYS = 30;
const DAY_MS = 86_400_000;

export function parseArguments(argv) {
  const options = { host: DEFAULT_HOST, minDays: DEFAULT_MIN_DAYS, timeoutMs: 15_000 };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--host") options.host = argv[(index += 1)];
    else if (argument === "--min-days") options.minDays = Number(argv[(index += 1)]);
    else throw new RangeError(`unknown argument: ${argument}`);
  }
  if (
    typeof options.host !== "string" ||
    !/^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/i.test(options.host)
  ) {
    throw new RangeError("--host must be a hostname");
  }
  if (!Number.isFinite(options.minDays) || options.minDays < 1 || options.minDays > 365) {
    throw new RangeError("--min-days must be a number from 1 to 365");
  }
  return options;
}

/** Whole days left, rounded down; negative once expired. */
export function daysUntil(validTo, now) {
  const expiry = Date.parse(validTo);
  if (!Number.isFinite(expiry)) throw new RangeError(`unreadable certificate expiry: ${validTo}`);
  return Math.floor((expiry - now.getTime()) / DAY_MS);
}

/** Decides the outcome from what the server presented. Pure, so it can be tested. */
export function evaluateCertificate(certificate, { minDays, now = new Date() }) {
  const days = daysUntil(certificate.validTo, now);
  const lines = [
    `Subject: ${certificate.subject ?? "unknown"}`,
    `Issuer:  ${certificate.issuer ?? "unknown"}`,
    `Expires: ${new Date(Date.parse(certificate.validTo)).toISOString()} (${String(days)} days left)`,
  ];
  let code = 0;
  if (certificate.authorizationError) {
    lines.push(`NOT TRUSTED for this host: ${certificate.authorizationError}`);
    code = 1;
  }
  if (days < 0) {
    lines.push("EXPIRED: public preview URLs fail TLS right now.");
    code = 1;
  } else if (days < minDays) {
    lines.push(
      `RENEW NOW: fewer than ${String(minDays)} days left. See "Renewing the preview wildcard certificate" in docs/azure-container-apps-preview-staging.md.`,
    );
    code = 1;
  }
  if (code === 0) lines.push(`OK: at least ${String(minDays)} days of validity left.`);
  return { code, days, lines };
}

/** Opens one TLS connection and returns the presented certificate. Sends no request. */
export function fetchCertificate(host, timeoutMs, connectImpl = connect) {
  return new Promise((resolvePromise, reject) => {
    const socket = connectImpl({
      host,
      port: 443,
      servername: host,
      // The point is to read the certificate even when it is bad, so trust failures are
      // reported through `authorizationError` instead of aborting the handshake.
      rejectUnauthorized: false,
    });
    socket.setTimeout(timeoutMs, () => {
      socket.destroy();
      reject(new Error(`timed out after ${String(timeoutMs)} ms`));
    });
    socket.once("error", reject);
    socket.once("secureConnect", () => {
      const peer = socket.getPeerCertificate();
      const authorizationError = socket.authorized ? undefined : String(socket.authorizationError);
      socket.end();
      if (!peer || !peer.valid_to) {
        reject(new Error("the server presented no certificate"));
        return;
      }
      resolvePromise({
        subject: peer.subject?.CN,
        issuer: peer.issuer?.O ?? peer.issuer?.CN,
        validTo: peer.valid_to,
        authorizationError,
      });
    });
  });
}

export async function run(
  argv,
  { fetchCertificateImpl = fetchCertificate, now = () => new Date(), write = console.log } = {},
) {
  let options;
  try {
    options = parseArguments(argv);
  } catch (error) {
    write(`usage error: ${error.message}`);
    return 2;
  }
  let certificate;
  try {
    certificate = await fetchCertificateImpl(options.host, options.timeoutMs);
  } catch (error) {
    write(`could not read the certificate from ${options.host}: ${error.message}`);
    return 2;
  }
  write(`Host:    ${options.host}`);
  let result;
  try {
    result = evaluateCertificate(certificate, { minDays: options.minDays, now: now() });
  } catch (error) {
    write(`could not evaluate the certificate: ${error.message}`);
    return 2;
  }
  for (const line of result.lines) write(line);
  return result.code;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await run(process.argv.slice(2));
}
