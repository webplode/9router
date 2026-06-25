import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { KiroService } from "../../src/lib/oauth/services/kiro.js";

/**
 * Runnable check for the two new Kiro auth paths ported from Kiro-Go
 * (sso_token.go) and kiro-login-helper.py (enterprise external-IdP):
 *   - importFromSsoToken: 7-step portal.sso device-code dance
 *   - external-IdP: descriptor resolution + code exchange + profile resolution
 *     with TokenType: EXTERNAL_IDP
 * Plus the SSRF allowlist guard on the external-IdP issuer/endpoints.
 *
 * fetch is mocked by URL; no real network is hit.
 */

// Helper: build a fetch mock that routes by URL substring to response specs.
function routeFetch(routes) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
    const u = String(url);
    for (const { match, respond } of routes) {
      if (u.includes(match)) {
        const r = await respond({ url: u, init });
        return {
          ok: r.ok ?? true,
          status: r.status ?? 200,
          json: async () => r.json,
          text: async () => r.text ?? JSON.stringify(r.json ?? ""),
        };
      }
    }
    throw new Error(`unexpected fetch: ${u}`);
  });
}

describe("kiro import-json (KiroService.importFromJson)", () => {
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => vi.restoreAllMocks());

  it("maps a kiro-login-helper.py JSON to a credential without any network call", () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const svc = new KiroService();
    const json = {
      type: "kiro",
      access_token: "eyJabc.def.ghi",
      refresh_token: "rt",
      profile_arn: "arn:aws:codewhisperer:us-east-1:444:profile/P",
      region: "us-east-1",
      auth_method: "external_idp",
      client_id: "idpClient",
      token_endpoint: "https://login.microsoftonline.com/tenant/oauth2/v2.0/token",
      issuer_url: "https://login.microsoftonline.com/tenant/v2.0",
      scopes: "api://x/codewhisperer:conversations offline_access",
      expired: new Date(Date.now() + 3600 * 1000).toISOString(),
      disabled: false,
      timestamp: Date.now(),
    };
    const cred = svc.importFromJson(JSON.stringify(json));
    expect(cred.accessToken).toBe("eyJabc.def.ghi");
    expect(cred.refreshToken).toBe("rt");
    expect(cred.profileArn).toBe(json.profile_arn);
    expect(cred.authMethod).toBe("external_idp");
    expect(cred.clientId).toBe("idpClient");
    expect(cred.tokenEndpoint).toBe(json.token_endpoint);
    expect(cred.issuerUrl).toBe(json.issuer_url);
    expect(cred.scopes).toBe(json.scopes);
    expect(cred.region).toBe("us-east-1");
    expect(cred.expiresIn).toBeGreaterThan(0);
    // No network call — pure mapping.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects JSON with a non-kiro type", () => {
    const svc = new KiroService();
    expect(() => svc.importFromJson({ type: "codex", access_token: "a", refresh_token: "r" })).toThrow(/Expected type "kiro"/);
  });

  it("rejects JSON missing access_token or refresh_token", () => {
    const svc = new KiroService();
    expect(() => svc.importFromJson({ access_token: "a" })).toThrow(/access_token and refresh_token/);
  });

  it("rejects JSON whose profile_arn is not a CodeWhisperer ARN (e.g. a client_id GUID)", () => {
    const svc = new KiroService();
    expect(() =>
      svc.importFromJson({
        access_token: "a",
        refresh_token: "r",
        region: "us-east-1",
        profile_arn: "482b5fd8-bb62-4a8e-be45-2229f0df6540", // GUID, not ARN
      })
    ).toThrow(/not a valid CodeWhisperer ARN/);
  });

  it("accepts a well-formed CodeWhisperer ARN", () => {
    const svc = new KiroService();
    const cred = svc.importFromJson({
      access_token: "a",
      refresh_token: "r",
      region: "us-east-1",
      profile_arn: "arn:aws:codewhisperer:us-east-1:217422363316:profile/9DQXC4CADKAN",
    });
    expect(cred.profileArn).toBe("arn:aws:codewhisperer:us-east-1:217422363316:profile/9DQXC4CADKAN");
  });

  it("SSRF-validates the token_endpoint in the JSON", () => {
    const svc = new KiroService();
    expect(() =>
      svc.importFromJson({
        access_token: "a",
        refresh_token: "r",
        region: "us-east-1",
        token_endpoint: "https://internal.corp/token",
      })
    ).toThrow(/not allow-listed/);
  });
});

describe("kiro SSO-token import (KiroService.importFromSsoToken)", () => {
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => vi.restoreAllMocks());

  it("drives the 7-step portal.sso flow and returns a sso_token credential", async () => {
    const fetchMock = routeFetch([
      // 1. register OIDC device client
      {
        match: "/client/register",
        respond: () => ({ json: { clientId: "cid", clientSecret: "csec" } }),
      },
      // 5. accept_user_code (must precede /device_authorization - its URL contains that prefix)
      {
        match: "/accept_user_code",
        respond: () => ({
          json: { deviceContext: { deviceContextId: "dctx", clientId: "cid", clientType: "public" } },
        }),
      },
      // 6. associate_token
      {
        match: "/associate_token",
        respond: () => ({ json: {} }),
      },
      // 2. device authorization (plain /device_authorization, not the sub-paths)
      {
        match: "/device_authorization",
        respond: () => ({ json: { deviceCode: "devcode", userCode: "usercode", interval: 1 } }),
      },
      // 3. portal whoAmI
      {
        match: "portal.sso.us-east-1.amazonaws.com/token/whoAmI",
        respond: () => ({ json: {} }),
      },
      // 4. portal session/device
      {
        match: "portal.sso.us-east-1.amazonaws.com/session/device",
        respond: () => ({ json: { token: "devSessionToken" } }),
      },
      // 7. poll OIDC /token
      {
        match: "oidc.us-east-1.amazonaws.com/token",
        respond: () => ({ json: { accessToken: "acc", refreshToken: "ref", expiresIn: 3600, profileArn: null } }),
      },
      // profile resolution (no profileArn from OIDC)
      {
        match: "codewhisperer.us-east-1.amazonaws.com",
        respond: () => ({
          json: { profiles: [{ arn: "arn:aws:codewhisperer:us-east-1:444:profile/P" }] },
        }),
      },
    ]);

    const svc = new KiroService();
    const cred = await svc.importFromSsoToken("bearer-token", "us-east-1");

    expect(cred.authMethod).toBe("sso_token");
    expect(cred.accessToken).toBe("acc");
    expect(cred.refreshToken).toBe("ref");
    expect(cred.clientId).toBe("cid");
    expect(cred.clientSecret).toBe("csec");
    expect(cred.profileArn).toBe("arn:aws:codewhisperer:us-east-1:444:profile/P");
    expect(cred.region).toBe("us-east-1");

    // All 7 steps + profile resolution were hit.
    const urls = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(urls.some((u) => u.includes("/client/register"))).toBe(true);
    expect(urls.some((u) => u.includes("/device_authorization") && !u.includes("/accept_user_code") && !u.includes("/associate_token"))).toBe(true);
    expect(urls.some((u) => u.includes("/token/whoAmI"))).toBe(true);
    expect(urls.some((u) => u.includes("/session/device"))).toBe(true);
    expect(urls.some((u) => u.includes("/accept_user_code"))).toBe(true);
    expect(urls.some((u) => u.includes("/associate_token"))).toBe(true);
    expect(urls.some((u) => u.includes("oidc.us-east-1.amazonaws.com/token"))).toBe(true);
  });

  it("rejects an empty bearer token without a network call", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const svc = new KiroService();
    await expect(svc.importFromSsoToken("  ")).rejects.toThrow("SSO bearer token is required");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("kiro external-IdP (KiroService external-IdP methods)", () => {
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => vi.restoreAllMocks());

  it("builds a hosted signin URL with PKCE + state", () => {
    const svc = new KiroService();
    const r = svc.startExternalIdpLogin("us-east-1");
    expect(r.signinUrl.startsWith("https://app.kiro.dev/signin?")).toBe(true);
    expect(r.signinUrl).toContain("redirect_uri=http%3A%2F%2Flocalhost%3A3128");
    expect(r.signinUrl).not.toContain("oauth%2Fcallback");
    expect(r.signinUrl).toContain("redirect_from=KiroIDE");
    expect(r.signinUrl).toContain("code_challenge_method=S256");
    expect(r.state).toBeTruthy();
    expect(r.codeVerifier).toBeTruthy();
    expect(r.codeChallenge).toBeTruthy();
  });

  it("resolves an external-IdP descriptor, exchanges the code, and resolves profileArn with TokenType: EXTERNAL_IDP", async () => {
    routeFetch([
      {
        match: "/.well-known/openid-configuration",
        respond: () => ({
          json: {
            authorization_endpoint: "https://login.microsoftonline.com/tenant/oauth2/v2.0/authorize",
            token_endpoint: "https://login.microsoftonline.com/tenant/oauth2/v2.0/token",
          },
        }),
      },
      {
        match: "login.microsoftonline.com/tenant/oauth2/v2.0/token",
        respond: () => ({ json: { access_token: "idpAccess", refresh_token: "idpRefresh", expires_in: 3600 } }),
      },
      {
        match: "codewhisperer.us-east-1.amazonaws.com",
        respond: ({ init }) => {
          // The external-IdP path MUST send TokenType: EXTERNAL_IDP.
          expect(init.headers["TokenType"]).toBe("EXTERNAL_IDP");
          expect(init.headers["User-Agent"]).toMatch(/KiroIDE-/);
          return { json: { profiles: [{ arn: "arn:aws:codewhisperer:us-east-1:444:profile/E" }] } };
        },
      },
    ]);

    const svc = new KiroService();
    const { authUrl, leg2 } = await svc.resolveExternalIdpDescriptor({
      issuer_url: "https://login.microsoftonline.com/tenant/v2.0",
      client_id: "idpClient",
      scopes: "openid email profile",
      login_hint: "user@corp.com",
    });
    expect(authUrl.startsWith("https://login.microsoftonline.com/tenant/oauth2/v2.0/authorize?")).toBe(true);
    expect(authUrl).toContain("login_hint=user%40corp.com");
    expect(leg2.clientId).toBe("idpClient");
    expect(leg2.tokenEndpoint).toBe("https://login.microsoftonline.com/tenant/oauth2/v2.0/token");

    const cred = await svc.completeExternalIdpCallback({
      code: "idpCode",
      leg2,
      region: "us-east-1",
    });
    expect(cred.authMethod).toBe("external_idp");
    expect(cred.accessToken).toBe("idpAccess");
    expect(cred.refreshToken).toBe("idpRefresh");
    expect(cred.profileArn).toBe("arn:aws:codewhisperer:us-east-1:444:profile/E");
    expect(cred.clientId).toBe("idpClient");
    expect(cred.tokenEndpoint).toBe(leg2.tokenEndpoint);
  });

  it("SSRF guard: rejects non-allowlisted / http / IP / evil-suffix issuers pre-fetch", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const svc = new KiroService();
    const bad = [
      "http://login.microsoftonline.com/x", // http
      "https://evil-microsoftonline.com/x", // not a real subdomain boundary
      "https://127.0.0.1/x", // IPv4 literal
      "https://[::1]/x", // IPv6 literal
      "https://169.254.169.254/x", // SSRF IP
      "https://internal.corp/x", // not allowlisted
      "",
    ];
    let thrown = 0;
    for (const issuer of bad) {
      try {
        await svc.resolveExternalIdpDescriptor({ issuer_url: issuer, client_id: "c", scopes: "s" });
      } catch {
        thrown++;
      }
    }
    expect(thrown).toBe(bad.length);
    // No network call should have been made for any bad issuer.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refreshExternalIdpToken posts a refresh_token grant and never echoes upstream body on failure", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({ error: "invalid_grant", error_description: "leaky" }),
      text: async () => "leaky upstream body",
    });
    const svc = new KiroService();
    await expect(
      svc.refreshExternalIdpToken("rt", {
        tokenEndpoint: "https://login.microsoftonline.com/tenant/oauth2/v2.0/token",
        clientId: "idpClient",
      })
    ).rejects.toThrow("external IdP token refresh failed");
  });
});

