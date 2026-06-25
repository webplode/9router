import { NextResponse } from "next/server";
import { KiroService } from "@/lib/oauth/services/kiro";

/**
 * GET /api/oauth/kiro/external-idp/signin-url
 * Sign-in URL only — no loopback listener (for manual paste flow on homelab/remote).
 */
export async function GET() {
  try {
    const kiroService = new KiroService();
    const { signinUrl } = kiroService.startExternalIdpLogin();
    return NextResponse.json({ signinUrl });
  } catch (error) {
    console.log("Kiro external-idp signin-url error:", error);
    return NextResponse.json({ error: "Failed to build sign-in URL" }, { status: 500 });
  }
}