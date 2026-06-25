import { NextResponse } from "next/server";
import { KiroService } from "@/lib/oauth/services/kiro";
import {
  startKiroExternalIdpProxy,
  registerKiroExternalIdpFlow,
} from "@/lib/oauth/utils/server";

/**
 * GET /api/oauth/kiro/external-idp/signin?region=us-east-1
 * Build the hosted app.kiro.dev/signin URL, bind the loopback listener on
 * 127.0.0.1:3128, and register the flow so the listener can correlate the
 * portal redirect(s). The browser opens the returned signinUrl in a
 * guest/incognito window; the listener captures the rest server-side.
 */
export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const region = (searchParams.get("region") || "us-east-1").trim();

    const startResult = await startKiroExternalIdpProxy();
    if (!startResult.success) {
      // ponytail: surface port_busy distinctly so the UI can tell the user
      // another sign-in is in flight or port 3128 is occupied.
      return NextResponse.json(
        { error: startResult.reason === "port_busy" ? "Callback port 3128 is busy" : "Failed to start callback listener" },
        { status: 503 }
      );
    }

    const kiroService = new KiroService();
    const { signinUrl, state, codeVerifier } = kiroService.startExternalIdpLogin(region);
    registerKiroExternalIdpFlow({ portalState: state, codeVerifier, region });

    return NextResponse.json({ signinUrl, state });
  } catch (error) {
    console.log("Kiro external-idp signin error:", error);
    return NextResponse.json({ error: "Failed to start external IdP sign-in" }, { status: 500 });
  }
}