import { NextResponse } from "next/server";
import { KiroService } from "@/lib/oauth/services/kiro";
import { createProviderConnection, getProviderConnections, deleteProviderConnection } from "@/models";

/**
 * POST /api/oauth/kiro/import-json
 * Import a kiro-login-helper.py credential JSON (snake_case fields).
 * Maps the JSON to a 9router connection. No network call required — the JSON
 * already carries access/refresh tokens, profile ARN, and IdP metadata.
 *
 * Supports both external_idp (M365/Entra) and OIDC (Builder ID/IDC/sso_token)
 * auth_method values by persisting the right providerSpecificData shape.
 */
export async function POST(request) {
  try {
    const { json } = await request.json();
    if (!json || (typeof json !== "string" && typeof json !== "object")) {
      return NextResponse.json({ error: "JSON payload is required" }, { status: 400 });
    }

    const kiroService = new KiroService();
    const credential = kiroService.importFromJson(json);

    const email = kiroService.extractEmailFromJWT(credential.accessToken);

    // Bypass the email-based dedup in createProviderConnection: if any existing
    // kiro connection shares this email, delete it first so the new record is
    // a clean write with a correct providerSpecificData (this fixes any stale
    // `profileArn` field left over from earlier attempts, which caused
    // "Invalid ARN 482b5fd8-..." errors when the runtime shipped the client_id
    // GUID as the profileArn).
    if (email) {
      const existing = await getProviderConnections({ provider: "kiro" });
      for (const c of existing) {
        if (c.email === email) {
          await deleteProviderConnection(c.id);
        }
      }
    }

    // external_idp (M365/Entra) stores IdP endpoints; OIDC methods store
    // clientId/clientSecret for refresh. Build providerSpecificData per method.
    const isExternalIdp = credential.authMethod === "external_idp";
    const providerSpecificData = {
      profileArn: credential.profileArn,
      region: credential.region,
      authMethod: credential.authMethod,
      ...(isExternalIdp
        ? {
            clientId: credential.clientId,
            tokenEndpoint: credential.tokenEndpoint,
            issuerUrl: credential.issuerUrl,
            scopes: credential.scopes,
            provider: "Microsoft 365",
          }
        : {
            clientId: credential.clientId,
            clientSecret: credential.clientSecret,
            startUrl: "https://view.awsapps.com/start",
            provider: "Imported JSON",
          }),
    };

    const connection = await createProviderConnection({
      provider: "kiro",
      authType: "oauth",
      accessToken: credential.accessToken,
      refreshToken: credential.refreshToken,
      expiresAt: credential.expiresIn
        ? new Date(Date.now() + credential.expiresIn * 1000).toISOString()
        : null,
      email: email || null,
      providerSpecificData,
      testStatus: "active",
    });

    return NextResponse.json({
      success: true,
      connection: {
        id: connection.id,
        provider: connection.provider,
        email: connection.email,
      },
      // Surface the persisted profileArn so the caller can verify a valid ARN
      // landed in the DB (defends against the "Invalid ARN <client_id>" bug).
      profileArn: connection.providerSpecificData?.profileArn || null,
      authMethod: credential.authMethod,
    });
  } catch (error) {
    console.log("Kiro import-json error:", error);
    return NextResponse.json({ error: error.message || "Import failed" }, { status: 500 });
  }
}