import { NextResponse } from "next/server";
import { KiroService } from "@/lib/oauth/services/kiro";
import { createProviderConnection } from "@/models";

/**
 * POST /api/oauth/kiro/sso-token
 * Automated import from an AWS SSO bearer token (x-amz-sso_authn captured from
 * the AWS SSO portal). Drives the 7-step portal.sso device-code dance headlessly
 * (Kiro-Go auth/sso_token.go). Fallback when the interactive external-IdP
 * browser flow isn't available.
 */
export async function POST(request) {
  try {
    const { bearerToken, region } = await request.json();

    if (!bearerToken || typeof bearerToken !== "string" || !bearerToken.trim()) {
      return NextResponse.json(
        { error: "SSO bearer token is required" },
        { status: 400 }
      );
    }

    const kiroService = new KiroService();
    const credential = await kiroService.importFromSsoToken(
      bearerToken.trim(),
      region || "us-east-1"
    );

    // Prefer JWT email; fall back to the getUsageLimits endpoint for non-JWT tokens.
    let email = kiroService.extractEmailFromJWT(credential.accessToken);
    if (!email) {
      const info = await kiroService.getUserInfo(credential.accessToken);
      email = info.email;
    }

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
        authMethod: "sso_token",
        clientId: credential.clientId,
        clientSecret: credential.clientSecret,
        provider: "SSO Token",
      },
      testStatus: "active",
    });

    return NextResponse.json({
      success: true,
      connection: {
        id: connection.id,
        provider: connection.provider,
        email: connection.email,
      },
    });
  } catch (error) {
    console.log("Kiro SSO token import error:", error);
    // Do not reflect upstream response body to the client (SSRF hardening)
    return NextResponse.json(
      { error: "SSO token import failed" },
      { status: 500 }
    );
  }
}