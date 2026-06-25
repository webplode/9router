import { randomBytes } from "crypto";

/** @type {Map<string, { leg2: object, region: string, expiresAt: number }>} */
const manualLeg2Sessions = new Map();

const MANUAL_SESSION_TTL_MS = 15 * 60 * 1000;

export function createKiroExternalIdpManualSession({ leg2, region }) {
  const sessionToken = randomBytes(24).toString("base64url");
  manualLeg2Sessions.set(sessionToken, {
    leg2,
    region: region || "us-east-1",
    expiresAt: Date.now() + MANUAL_SESSION_TTL_MS,
  });
  return sessionToken;
}

export function consumeKiroExternalIdpManualSession(sessionToken) {
  const row = manualLeg2Sessions.get(sessionToken);
  if (!row) return null;
  if (Date.now() > row.expiresAt) {
    manualLeg2Sessions.delete(sessionToken);
    return null;
  }
  manualLeg2Sessions.delete(sessionToken);
  return row;
}

export function parseKiroExternalIdpCallbackUrl(raw) {
  const trimmed = (raw || "").trim();
  if (!trimmed) throw new Error("Callback URL is required");
  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error("Invalid callback URL");
  }
  const q = Object.fromEntries(parsed.searchParams);
  const path = parsed.pathname || "";
  const loginOption = (q.login_option || "").toLowerCase();
  const isDescriptor =
    loginOption === "external_idp" || Boolean((q.issuer_url || "").trim());
  const isLeg2 =
    path === "/oauth/callback" || path.endsWith("/oauth/callback");
  const code = (q.code || "").trim();
  const err = (q.error || "").trim();
  return { parsed, path, q, isDescriptor, isLeg2, code, err };
}