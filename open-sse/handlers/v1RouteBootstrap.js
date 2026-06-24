import { handleChat } from "@/sse/handlers/chat.js";
import { initTranslators } from "../translator/index.js";

let initialized = false;

async function ensureInitialized() {
  if (!initialized) {
    await initTranslators();
    initialized = true;
  }
}

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "*",
};

/**
 * Shared bootstrap for /v1/* compatibility routes (CLIProxyAPI-style thin handlers).
 * All entry surfaces delegate to handleChat → handleChatCore → translate → executor.
 */
export async function OPTIONS() {
  return new Response(null, { headers: CORS_HEADERS });
}

export async function POST(request) {
  await ensureInitialized();
  return handleChat(request);
}