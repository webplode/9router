import { NextResponse } from "next/server";
import { KiroService } from "@/lib/oauth/services/kiro";
import { createProviderConnection } from "@/models";
import {
  parseKiroExternalIdpCallbackUrl,
  createKiroExternalIdpManualSession,
  consumeKiroExternalIdpManualSession,
} from "@/lib/oauth/utils/kiroExternalIdpManual";

/**
 * POST /api/oauth/kiro/external-idp/complete
 * Manual callback flow (homelab / remote UI — no localhost:3128 listener).
 *
 * Leg-1: paste Kiro descriptor URL (/signin/callback?login_option=external_idp&...)
 *   -> returns { step: "idp", authUrl, sessionToken } (open Microsoft login).
 * Leg-2: paste IdP redirect URL (/oauth/callback?code=...&state=...) + sessionToken
 *   -> persists connection.
 */
export async function POST(request) {
  try {
    const { callbackUrl, sessionToken, region } = await request.json();
    const svc = new KiroService();
    const { parsed, q, isDescriptor, isLeg2, code, err } = parseKiroExternalIdpCallbackUrl(callbackUrl);

    if (err) {
      return NextResponse.json({ error: "Authorization failed" }, { status: 400 });
    }

    // --- Leg-1: external IdP descriptor from Kiro portal ---
    const pathLooksLeg1 =
      parsed.pathname.includes("signin/callback") ||
      (isDescriptor && !code);
    if (isDescriptor && pathLooksLeg1) {
      const { authUrl, leg2 } = await svc.resolveExternalIdpDescriptor({
        issuer_url: q.issuer_url,
        client_id: q.client_id,
        scopes: q.scopes,
        login_hint: q.login_hint,
      });
      const token = createKiroExternalIdpManualSession({
        leg2,
        region: (region || "us-east-1").trim(),
      });
      return NextResponse.json({
        step: "idp",
        authUrl,
        sessionToken: token,
      });
    }

    // --- Leg-2: Microsoft (or other IdP) authorization code ---
    if (isLeg2 && code) {
      if (!sessionToken) {
        return NextResponse.json(
          { error: "Missing sessionToken — paste the signin/callback URL first" },
          { status: 400 }
        );
      }
      const session = consumeKiroExternalIdpManualSession(sessionToken);
      if (!session) {
        return NextResponse.json({ error: "Session expired — start again" }, { status: 400 });
      }
      const credential = await svc.completeExternalIdpCallback({
        code,
        leg2: session.leg2,
        region: session.region,
      });
      const email = svc.extractEmailFromJWT(credential.accessToken);
      const connection = await createProviderConnection({
        provider: "kiro",
        authType: "oauth",
        accessToken: credential.accessToken,
        refreshToken: credential.refreshToken,
        expiresAt: credential.expiresIn
          ? new Date(Date.now() + credential.expiresIn * 1000).toISOString()
          : null,
        email: email || null,
        providerSpecificData: {
          profileArn: credential.profileArn,
          region: credential.region,
          authMethod: "external_idp",
          clientId: credential.clientId,
          tokenEndpoint: credential.tokenEndpoint,
          issuerUrl: credential.issuerUrl,
          scopes: credential.scopes,
          provider: "Microsoft 365",
        },
        testStatus: "active",
      });
      return NextResponse.json({
        step: "done",
        success: true,
        connection: {
          id: connection.id,
          provider: connection.provider,
          email: connection.email,
        },
      });
    }

    return NextResponse.json(
      { error: "Unrecognized callback URL — paste signin/callback (leg 1) or oauth/callback (leg 2)" },
      { status: 400 }
    );
  } catch (error) {
    console.log("Kiro external-idp complete error:", error);
    return NextResponse.json({ error: "External IdP sign-in failed" }, { status: 500 });
  }
}