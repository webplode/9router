import { NextResponse } from "next/server";
import { providerIdSupportsModelsImport } from "@/shared/utils/providerModelsImportCapability";

export const dynamic = "force-dynamic";

/** GET /api/providers/import-capability?providerId=deepseek */
export async function GET(request) {
  const providerId = new URL(request.url).searchParams.get("providerId");
  if (!providerId) {
    return NextResponse.json({ error: "Missing providerId" }, { status: 400 });
  }
  return NextResponse.json({
    providerId,
    supportsModelsImport: providerIdSupportsModelsImport(providerId),
  });
}