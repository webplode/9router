import { NextResponse } from "next/server";
import {
  getKiroExternalIdpFlowStatus,
  clearKiroExternalIdpFlow,
  stopKiroExternalIdpProxy,
} from "@/lib/oauth/utils/server";

/**
 * GET /api/oauth/kiro/external-idp/status?state=<portalState>
 * Poll the in-flight external-IdP flow. The loopback listener performs the
 * token exchange + DB persistence server-side, so once status is "done" the
 * modal just needs the connection id/email to refresh its list. Terminal
 * states ("done", "error") clear the flow and stop the listener.
 */
export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const state = searchParams.get("state");
    if (!state) {
      return NextResponse.json({ error: "Missing state" }, { status: 400 });
    }

    const flow = getKiroExternalIdpFlowStatus(state);
    if (!flow) return NextResponse.json({ status: "unknown" });

    if (flow.status === "done" || flow.status === "error") {
      const payload = { status: flow.status, connectionId: flow.connectionId, email: flow.email, error: flow.error };
      clearKiroExternalIdpFlow(state);
      stopKiroExternalIdpProxy();
      return NextResponse.json(payload);
    }

    // "pending" / "social_code" remain in flight.
    return NextResponse.json({
      status: flow.status,
      ...(flow.status === "social_code" ? { socialCode: flow.socialCode } : {}),
    });
  } catch (error) {
    console.log("Kiro external-idp status error:", error);
    return NextResponse.json({ error: "Status check failed" }, { status: 500 });
  }
}