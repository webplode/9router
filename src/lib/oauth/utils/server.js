import http from "http";
import { URL } from "url";
import { CODEX_CONFIG } from "../constants/oauth.js";

/**
 * Start a local HTTP server to receive OAuth callback
 * @param {Function} onCallback - Called with query params when callback received
 * @param {number} fixedPort - Optional fixed port number (default: random)
 * @returns {Promise<{server: http.Server, port: number, close: Function}>}
 */
export function startLocalServer(onCallback, fixedPort = null) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, `http://localhost`);

      if (url.pathname === "/callback" || url.pathname === "/auth/callback") {
        const params = Object.fromEntries(url.searchParams);

        // Send success response to browser with auto-close attempt
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(`<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Authentication Successful</title>
  <style>
    body { font-family: system-ui; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; background: #f5f5f5; }
    .container { text-align: center; padding: 2rem; background: white; border-radius: 8px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
    .success { color: #22c55e; font-size: 3rem; }
    h1 { margin: 1rem 0; }
    p { color: #666; }
    #countdown { font-weight: bold; }
  </style>
</head>
<body>
  <div class="container">
    <div class="success">&#10003;</div>
    <h1>Authentication Successful</h1>
    <p id="message">Closing in <span id="countdown">3</span> seconds...</p>
  </div>
  <script>
    let count = 3;
    const countdown = document.getElementById("countdown");
    const message = document.getElementById("message");
    const timer = setInterval(() => {
      count--;
      countdown.textContent = count;
      if (count <= 0) {
        clearInterval(timer);
        window.close();
        setTimeout(() => {
          message.textContent = "Please close this tab manually.";
        }, 500);
      }
    }, 1000);
  </script>
</body>
</html>`);

        // Call callback with params
        onCallback(params);
      } else {
        res.writeHead(404);
        res.end("Not found");
      }
    });

    // Listen on fixed port or find available port
    const portToUse = fixedPort || 0;
    server.listen(portToUse, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({
        server,
        port,
        close: () => server.close(),
      });
    });

    server.on("error", (err) => {
      if (err.code === "EADDRINUSE" && fixedPort) {
        reject(new Error(`Port ${fixedPort} is already in use. Please close other applications using this port.`));
      } else {
        reject(err);
      }
    });
  });
}

/**
 * Wait for callback with timeout
 * @param {number} timeoutMs - Timeout in milliseconds
 * @returns {Promise<Object>} - Callback params
 */
export function waitForCallback(timeoutMs = 300000) {
  return new Promise((resolve, reject) => {
    let resolved = false;

    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        reject(new Error("Authentication timeout"));
      }
    }, timeoutMs);

    const onCallback = (params) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timeout);
        resolve(params);
      }
    };

    // Return the callback function
    resolve.__onCallback = onCallback;
  });
}

// Singleton proxy server for Codex OAuth callback on fixed port
let codexProxyServer = null;
let codexProxyTimeout = null;

const CODEX_PROXY_TIMEOUT_MS = 300000; // 5 minutes
const CODEX_PORT = CODEX_CONFIG.fixedPort;

// Pending exchange sessions keyed by state — used by server-side exchange mode
const pendingExchanges = new Map();

/**
 * Register a pending exchange session for server-side mode.
 * Modal client calls this before opening popup.
 */
export function registerCodexSession({ state, codeVerifier, redirectUri }) {
  if (!state || !codeVerifier || !redirectUri) return false;
  pendingExchanges.set(state, {
    codeVerifier,
    redirectUri,
    status: "pending",
    createdAt: Date.now(),
  });
  return true;
}

/**
 * Read session status (modal polls this).
 */
export function getCodexSessionStatus(state) {
  return pendingExchanges.get(state) || null;
}

/**
 * Clear a session (called after modal consumes status).
 */
export function clearCodexSession(state) {
  pendingExchanges.delete(state);
}

function renderCodexResultPage(success, message) {
  const color = success ? "#22c55e" : "#ef4444";
  const icon = success ? "&#10003;" : "&#10007;";
  const title = success ? "Authentication Successful" : "Authentication Failed";
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>${title}</title>
<style>body{font-family:system-ui;display:flex;justify-content:center;align-items:center;height:100vh;margin:0;background:#f5f5f5}.c{text-align:center;padding:2rem;background:#fff;border-radius:8px;box-shadow:0 2px 10px rgba(0,0,0,.1)}.i{color:${color};font-size:3rem}h1{margin:1rem 0}p{color:#666}</style>
</head><body><div class="c"><div class="i">${icon}</div><h1>${title}</h1><p>${message}</p><p>Closing in <span id="cd">3</span>s...</p>
<script>let n=3;const c=document.getElementById("cd");const t=setInterval(()=>{n--;c.textContent=n;if(n<=0){clearInterval(t);window.close();}},1000);</script>
</div></body></html>`;
}

/**
 * Start Codex proxy on fixed port 1455.
 * Mode A (server-side): if any session was registered, proxy auto-exchanges + saves DB.
 * Mode B (channel fallback): if no session, proxy 302 redirects to app port for legacy channel-based flow.
 */
export function startCodexProxy(appPort) {
  return new Promise((resolve) => {
    if (codexProxyServer) {
      resolve({ success: true });
      return;
    }

    const server = http.createServer(async (req, res) => {
      const url = new URL(req.url, "http://localhost");

      if (url.pathname !== "/callback" && url.pathname !== "/auth/callback") {
        res.writeHead(404);
        res.end("Not found");
        return;
      }

      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      const errorParam = url.searchParams.get("error");
      const session = state ? pendingExchanges.get(state) : null;

      // Mode A: server-side exchange (session registered)
      if (session) {
        try {
          if (errorParam) {
            throw new Error(url.searchParams.get("error_description") || errorParam);
          }
          if (!code) throw new Error("No authorization code received");

          // Lazy import to avoid circular deps
          const { exchangeTokens } = await import("../providers.js");
          const { createProviderConnection } = await import("@/models");

          const tokenData = await exchangeTokens(
            "codex",
            code,
            session.redirectUri,
            session.codeVerifier,
            state
          );
          const connection = await createProviderConnection({
            provider: "codex",
            authType: "oauth",
            ...tokenData,
            expiresAt: tokenData.expiresIn
              ? new Date(Date.now() + tokenData.expiresIn * 1000).toISOString()
              : null,
            testStatus: "active",
          });

          session.status = "done";
          session.connectionId = connection.id;
          session.email = connection.email;

          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
          res.end(renderCodexResultPage(true, "You can close this window."));
        } catch (err) {
          session.status = "error";
          session.error = err.message;
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
          res.end(renderCodexResultPage(false, err.message));
        } finally {
          stopCodexProxy();
        }
        return;
      }

      // Mode B: legacy channel fallback — 302 redirect to app /callback
      const redirectUrl = `http://localhost:${appPort}/callback${url.search}`;
      res.writeHead(302, { Location: redirectUrl });
      res.end();
      stopCodexProxy();
    });

    server.listen(CODEX_PORT, "127.0.0.1", () => {
      codexProxyServer = server;
      codexProxyTimeout = setTimeout(() => stopCodexProxy(), CODEX_PROXY_TIMEOUT_MS);
      resolve({ success: true });
    });

    server.on("error", (err) => {
      if (err.code === "EADDRINUSE") {
        resolve({ success: false, reason: "port_busy" });
      } else {
        resolve({ success: false, reason: err.message });
      }
    });
  });
}

/**
 * Stop the Codex proxy server and cleanup
 */
export function stopCodexProxy() {
  if (codexProxyTimeout) {
    clearTimeout(codexProxyTimeout);
    codexProxyTimeout = null;
  }
  if (codexProxyServer) {
    codexProxyServer.close();
    codexProxyServer = null;
  }
}

// ───────────────────────────────────────────────────────────────────────────
// xAI fixed-port proxy on 127.0.0.1:56121
// Same shape as the Codex proxy. Kept as a parallel implementation rather than
// generalizing the Codex one to keep the codex hot-path byte-equivalent.
// ───────────────────────────────────────────────────────────────────────────

let xaiProxyServer = null;
let xaiProxyTimeout = null;
const XAI_PROXY_TIMEOUT_MS = 300000; // 5 minutes
const XAI_PROXY_PORT = 56121;
const xaiPendingExchanges = new Map();

export function registerXaiSession({ state, codeVerifier, redirectUri }) {
  if (!state || !codeVerifier || !redirectUri) return false;
  xaiPendingExchanges.set(state, {
    codeVerifier,
    redirectUri,
    status: "pending",
    createdAt: Date.now(),
  });
  return true;
}

export function getXaiSessionStatus(state) {
  return xaiPendingExchanges.get(state) || null;
}

export function clearXaiSession(state) {
  xaiPendingExchanges.delete(state);
}

function renderXaiResultPage(success, message) {
  return renderCodexResultPage(success, message);
}

/**
 * Start xAI proxy on fixed port 56121.
 * Mode A (server-side): if any session was registered, proxy auto-exchanges + saves DB.
 * Mode B (channel fallback): if no session, proxy 302 redirects to app port.
 */
export function startXaiProxy(appPort) {
  return new Promise((resolve) => {
    if (xaiProxyServer) {
      resolve({ success: true });
      return;
    }

    const server = http.createServer(async (req, res) => {
      const url = new URL(req.url, "http://localhost");
      if (url.pathname !== "/callback" && url.pathname !== "/auth/callback") {
        res.writeHead(404);
        res.end("Not found");
        return;
      }

      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      const errorParam = url.searchParams.get("error");
      const session = state ? xaiPendingExchanges.get(state) : null;

      // Mode A: server-side exchange
      if (session) {
        try {
          if (errorParam) {
            throw new Error(url.searchParams.get("error_description") || errorParam);
          }
          if (!code) throw new Error("No authorization code received");

          const { exchangeTokens } = await import("../providers.js");
          const { createProviderConnection } = await import("@/models");

          const tokenData = await exchangeTokens(
            "xai",
            code,
            session.redirectUri,
            session.codeVerifier,
            state
          );
          const connection = await createProviderConnection({
            provider: "xai",
            authType: "oauth",
            ...tokenData,
            expiresAt: tokenData.expiresIn
              ? new Date(Date.now() + tokenData.expiresIn * 1000).toISOString()
              : null,
            testStatus: "active",
          });

          session.status = "done";
          session.connectionId = connection.id;
          session.email = connection.email;

          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
          res.end(renderXaiResultPage(true, "You can close this window."));
        } catch (err) {
          session.status = "error";
          session.error = err.message;
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
          res.end(renderXaiResultPage(false, err.message));
        } finally {
          stopXaiProxy();
        }
        return;
      }

      // Mode B: legacy fallback redirect
      const redirectUrl = `http://localhost:${appPort}/callback${url.search}`;
      res.writeHead(302, { Location: redirectUrl });
      res.end();
      stopXaiProxy();
    });

    server.listen(XAI_PROXY_PORT, "127.0.0.1", () => {
      xaiProxyServer = server;
      xaiProxyTimeout = setTimeout(() => stopXaiProxy(), XAI_PROXY_TIMEOUT_MS);
      resolve({ success: true });
    });

    server.on("error", (err) => {
      if (err.code === "EADDRINUSE") {
        resolve({ success: false, reason: "port_busy" });
      } else {
        resolve({ success: false, reason: err.message });
      }
    });
  });
}

export function stopXaiProxy() {
  if (xaiProxyTimeout) {
    clearTimeout(xaiProxyTimeout);
    xaiProxyTimeout = null;
  }
  if (xaiProxyServer) {
    xaiProxyServer.close();
    xaiProxyServer = null;
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Kiro Enterprise external-IdP (M365/Entra ID/Azure AD) loopback proxy on
// 127.0.0.1:3128. Ported from zsecducna/kiro-login-helper.py CallbackHandler.
// Two-leg state machine:
//   leg-1 (portal descriptor, path != /oauth/callback): issuer_url/client_id/
//     scopes/login_hint -> OIDC-discover the IdP, 302 the browser to the IdP
//     authorize endpoint, store leg-2 context under the flow.
//   leg-2 (IdP code, path == /oauth/callback): exchange the code at the IdP
//     token endpoint, resolve CodeWhisperer profileArn, persist connection.
//   social leg (path != /oauth/callback, has code + matching portal state):
//     Cognito code -> handled by the social-exchange route path elsewhere; here
//     we capture and deliver it for the route to finish.
// Flow state is keyed by the portal `state` generated by KiroService.
// ─────────────────────────────────────────────────────────────────────────

let kiroExternalIdpProxyServer = null;
let kiroExternalIdpProxyTimeout = null;
const KIRO_EXTERNAL_IDP_PROXY_PORT = 3128;
const KIRO_EXTERNAL_IDP_PROXY_TIMEOUT_MS = 10 * 60 * 1000; // 10 min
const KIRO_EXTERNAL_IDP_CALLBACK_PATH = "/oauth/callback";
const KIRO_EXTERNAL_IDP_SIGNIN_CALLBACK_PATH = "/signin/callback";

function _findKiroExternalIdpFlow(q) {
  if (q.state) {
    const byState = kiroExternalIdpFlows.get(q.state);
    if (byState) return byState;
    for (const f of kiroExternalIdpFlows.values()) {
      if (f.leg2 && f.leg2.state === q.state) return f;
    }
  }
  // Portal leg-1 descriptor often carries a different state than our sign-in
  // URL; bind to the single in-flight pending flow (helper.py uses one listener).
  for (const f of kiroExternalIdpFlows.values()) {
    if (f.status === "pending" && !f.leg2) return f;
  }
  return null;
}
// FlowState per active login attempt.
const kiroExternalIdpFlows = new Map();

/**
 * Register a Kiro external-IdP flow so the loopback proxy can correlate the
 * portal redirect(s). `portalState` is the state KiroService.startExternalIdpLogin
 * embedded in the signin URL. `codeVerifier` is the social-leg PKCE verifier.
 * `region` is the CodeWhisperer region for profile resolution.
 */
export function registerKiroExternalIdpFlow({ portalState, codeVerifier, region }) {
  if (!portalState || !codeVerifier) return false;
  kiroExternalIdpFlows.set(portalState, {
    portalState,
    codeVerifier,
    region: region || "us-east-1",
    leg2: null, // set when the external-IdP descriptor arrives
    status: "pending",
    createdAt: Date.now(),
  });
  return true;
}

export function getKiroExternalIdpFlowStatus(portalState) {
  return kiroExternalIdpFlows.get(portalState) || null;
}

export function clearKiroExternalIdpFlow(portalState) {
  kiroExternalIdpFlows.delete(portalState);
}

/**
 * Start the Kiro external-IdP loopback proxy on 127.0.0.1:3128. Singleton; if
 * already running, resolves immediately. Auto-stops after 10 min.
 */
export function startKiroExternalIdpProxy() {
  return new Promise((resolve) => {
    if (kiroExternalIdpProxyServer) {
      resolve({ success: true });
      return;
    }

    const server = http.createServer(async (req, res) => {
      const url = new URL(req.url, "http://localhost");
      const path = url.pathname;
      const q = Object.fromEntries(url.searchParams);

      const flow = _findKiroExternalIdpFlow(q);

      const isDescriptor =
        (q.login_option || "").toLowerCase() === "external_idp" || Boolean((q.issuer_url || "").trim());
      const isSigninCallback =
        path === KIRO_EXTERNAL_IDP_SIGNIN_CALLBACK_PATH || path.endsWith("/signin/callback");

      // --- Enterprise leg-1: external-IdP descriptor at /signin/callback ---
      if (isSigninCallback && isDescriptor) {
        if (!flow || flow.leg2) {
          res.writeHead(204); res.end(); return; // stray/duplicate hit
        }
        try {
          const { KiroService } = await import("../services/kiro.js");
          const svc = new KiroService();
          const { authUrl, leg2 } = await svc.resolveExternalIdpDescriptor({
            issuer_url: q.issuer_url,
            client_id: q.client_id,
            scopes: q.scopes,
            login_hint: q.login_hint,
          });
          flow.leg2 = leg2;
          res.writeHead(302, { Location: authUrl });
          res.end();
        } catch (err) {
          flow.status = "error";
          flow.error = err.message;
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
          res.end(renderCodexResultPage(false, "External IdP setup failed."));
          stopKiroExternalIdpProxy();
        }
        return;
      }

      // --- Enterprise leg-2: IdP authorization code at /oauth/callback ---
      if (path === KIRO_EXTERNAL_IDP_CALLBACK_PATH) {
        if (!flow || !flow.leg2 || q.state !== flow.leg2.state) {
          res.writeHead(204); res.end(); return; // no matching in-flight leg-2
        }
        const errParam = (q.error || "").trim();
        if (errParam) {
          flow.status = "error";
          flow.error = `external IdP authorization error: ${errParam}`;
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
          res.end(renderCodexResultPage(false, "Authorization failed."));
          stopKiroExternalIdpProxy();
          return;
        }
        const code = (q.code || "").trim();
        if (!code) {
          res.writeHead(204); res.end(); return;
        }
        // Deliver the captured code + leg2 for the route to finish (the route
        // polls flow.status; we set done after the exchange). Exchange here.
        try {
          const { KiroService } = await import("../services/kiro.js");
          const { createProviderConnection } = await import("@/models");
          const svc = new KiroService();
          const credential = await svc.completeExternalIdpCallback({
            code,
            leg2: flow.leg2,
            region: flow.region,
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
          flow.status = "done";
          flow.connectionId = connection.id;
          flow.email = connection.email;
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
          res.end(renderCodexResultPage(true, "You can close this window."));
        } catch (err) {
          flow.status = "error";
          flow.error = err.message;
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
          res.end(renderCodexResultPage(false, "Sign-in failed."));
        } finally {
          stopKiroExternalIdpProxy();
        }
        return;
      }

      // --- Social leg (Google/GitHub via app.kiro.dev/signin) ---
      // Captured here; the caller polls flow.status and finishes via the
      // existing social-exchange route if desired. We just record the code.
      const code = (q.code || "").trim();
      const errParam = (q.error || "").trim();
      if ((!code && !errParam) || !flow || q.state !== flow.portalState) {
        res.writeHead(204); res.end(); return;
      }
      if (errParam) {
        flow.status = "error";
        flow.error = `SSO authorization error: ${errParam}`;
      } else {
        flow.status = "social_code";
        flow.socialCode = code;
      }
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(renderCodexResultPage(!errParam, errParam ? "Authorization failed." : "You can close this window."));
      stopKiroExternalIdpProxy();
    });

    // Default 127.0.0.1 on host; in Docker set KIRO_EXTERNAL_IDP_BIND=0.0.0.0 so
    // published port 3128 reaches the listener.
    const bindHost = process.env.KIRO_EXTERNAL_IDP_BIND || "127.0.0.1";
    server.listen(KIRO_EXTERNAL_IDP_PROXY_PORT, bindHost, () => {
      kiroExternalIdpProxyServer = server;
      kiroExternalIdpProxyTimeout = setTimeout(
        () => stopKiroExternalIdpProxy(),
        KIRO_EXTERNAL_IDP_PROXY_TIMEOUT_MS
      );
      resolve({ success: true });
    });

    server.on("error", (err) => {
      if (err.code === "EADDRINUSE") {
        resolve({ success: false, reason: "port_busy" });
      } else {
        resolve({ success: false, reason: err.message });
      }
    });
  });
}

export function stopKiroExternalIdpProxy() {
  if (kiroExternalIdpProxyTimeout) {
    clearTimeout(kiroExternalIdpProxyTimeout);
    kiroExternalIdpProxyTimeout = null;
  }
  if (kiroExternalIdpProxyServer) {
    kiroExternalIdpProxyServer.close();
    kiroExternalIdpProxyServer = null;
  }
}

