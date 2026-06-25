import { createHash, randomBytes as _cryptoRandomBytes } from "crypto";
import { KIRO_CONFIG, assertValidAwsRegion } from "../constants/oauth.js";

/**
 * Kiro OAuth Service
 * Supports multiple authentication methods:
 * 1. AWS Builder ID (Device Code Flow)
 * 2. AWS IAM Identity Center/IDC (Device Code Flow)
 * 3. Google/GitHub Social Login (Authorization Code Flow + Manual Callback)
 * 4. Import Token (Manual refresh token paste)
 */

const KIRO_AUTH_SERVICE = "https://prod.us-east-1.auth.desktop.kiro.dev";

// Kiro IDE version embedded in the User-Agent. CodeWhisperer rejects non-Kiro
// UAs for external-IdP (M365/Entra) tokens. ponytail: bump when Kiro IDE bumps.
const KIRO_IDE_VERSION = "0.10.32";

// Loopback base URL whitelisted by app.kiro.dev/signin. The portal redirects
// leg-1 descriptors to {redirect_uri}/signin/callback (NOT /oauth/callback).
// Leg-2 IdP authorization_code uses KIRO_EXTERNAL_IDP_OAUTH_CALLBACK_URI.
const KIRO_EXTERNAL_IDP_LOOPBACK_BASE = "http://localhost:3128";
const KIRO_EXTERNAL_IDP_OAUTH_CALLBACK_URI = "http://localhost:3128/oauth/callback";
const KIRO_EXTERNAL_IDP_SIGNIN_URL = "https://app.kiro.dev/signin";
const KIRO_EXTERNAL_IDP_REDIRECT_FROM = "KiroIDE";

// Allow-list of IdP issuer/endpoint host suffixes the enterprise leg may talk
// to. The issuer arrives in an attacker-influenceable portal callback, so it is
// constrained to known Microsoft Entra/Azure AD hosts. Leading dot anchors the
// suffix to a real subdomain boundary so "evil-microsoftonline.com" can't match.
// ponytail: add more suffixes to onboard additional enterprise IdPs.
const ALLOWED_EXTERNAL_IDP_SUFFIXES = [
  ".microsoftonline.com",
  ".microsoftonline.us",
  ".microsoftonline.cn",
];

function _buildMachineId(...parts) {
  // Mirror helper.py BuildMachineID: hex SHA-256 of pipe-joined parts.
  return createHash("sha256").update(parts.join("|")).digest("hex");
}

function _kiroUserAgent(machineId) {
  return `aws-sdk-js/1.0.0 ua/2.1 os/windows#10.0.26200 lang/js md/nodejs#22.21.1 api/codewhispererruntime#1.0.0 m/N,E KiroIDE-${KIRO_IDE_VERSION}-${machineId}`;
}

function _kiroxAmzUserAgent(machineId) {
  return `aws-sdk-js/1.0.0 KiroIDE-${KIRO_IDE_VERSION}-${machineId}`;
}

export class KiroService {
  /**
   * Register OIDC client with AWS SSO
   * Returns clientId and clientSecret for device code flow
   */
  async registerClient(region = "us-east-1") {
    assertValidAwsRegion(region);
    const endpoint = `https://oidc.${region}.amazonaws.com/client/register`;

    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        clientName: KIRO_CONFIG.clientName,
        clientType: KIRO_CONFIG.clientType,
        scopes: KIRO_CONFIG.scopes,
        grantTypes: KIRO_CONFIG.grantTypes,
        issuerUrl: KIRO_CONFIG.issuerUrl,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Failed to register client: ${error}`);
    }

    const data = await response.json();
    return {
      clientId: data.clientId,
      clientSecret: data.clientSecret,
      clientSecretExpiresAt: data.clientSecretExpiresAt,
    };
  }

  /**
   * Start device authorization for AWS Builder ID or IDC
   */
  async startDeviceAuthorization(clientId, clientSecret, startUrl, region = "us-east-1") {
    assertValidAwsRegion(region);
    const endpoint = `https://oidc.${region}.amazonaws.com/device_authorization`;

    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        clientId,
        clientSecret,
        startUrl,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Failed to start device authorization: ${error}`);
    }

    const data = await response.json();
    return {
      deviceCode: data.deviceCode,
      userCode: data.userCode,
      verificationUri: data.verificationUri,
      verificationUriComplete: data.verificationUriComplete,
      expiresIn: data.expiresIn,
      interval: data.interval || 5,
    };
  }

  /**
   * Poll for token using device code (AWS Builder ID/IDC)
   */
  async pollDeviceToken(clientId, clientSecret, deviceCode, region = "us-east-1") {
    assertValidAwsRegion(region);
    const endpoint = `https://oidc.${region}.amazonaws.com/token`;

    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        clientId,
        clientSecret,
        deviceCode,
        grantType: "urn:ietf:params:oauth:grant-type:device_code",
      }),
    });

    const data = await response.json();

    // Handle pending/slow_down/errors
    if (!response.ok || data.error) {
      return {
        success: false,
        error: data.error,
        errorDescription: data.error_description,
        pending: data.error === "authorization_pending" || data.error === "slow_down",
      };
    }

    return {
      success: true,
      tokens: {
        accessToken: data.accessToken,
        refreshToken: data.refreshToken,
        expiresIn: data.expiresIn,
        tokenType: data.tokenType,
      },
    };
  }

  /**
   * Build Google/GitHub social login URL
   * Returns authorization URL for manual callback flow
   * Uses kiro:// custom protocol as required by AWS Cognito whitelist
   */
  buildSocialLoginUrl(provider, codeChallenge, state) {
    const idp = provider === "google" ? "Google" : "Github";
    // AWS Cognito only whitelists kiro:// protocol, not localhost
    const redirectUri = "kiro://kiro.kiroAgent/authenticate-success";
    return `${KIRO_AUTH_SERVICE}/login?idp=${idp}&redirect_uri=${encodeURIComponent(redirectUri)}&code_challenge=${codeChallenge}&code_challenge_method=S256&state=${state}&prompt=select_account`;
  }

  /**
   * Exchange authorization code for tokens (Social Login)
   * Must use same redirect_uri as authorization request
   */
  async exchangeSocialCode(code, codeVerifier) {
    // Must match the redirect_uri used in buildSocialLoginUrl
    const redirectUri = "kiro://kiro.kiroAgent/authenticate-success";

    const response = await fetch(`${KIRO_AUTH_SERVICE}/oauth/token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        code,
        code_verifier: codeVerifier,
        redirect_uri: redirectUri,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Token exchange failed: ${error}`);
    }

    const data = await response.json();
    return {
      accessToken: data.accessToken,
      refreshToken: data.refreshToken,
      profileArn: data.profileArn,
      expiresIn: data.expiresIn || 3600,
    };
  }

  /**
   * Refresh token using refresh token
   */
  async refreshToken(refreshToken, providerSpecificData = {}) {
    const { authMethod, clientId, clientSecret, region } = providerSpecificData;

    // External-IdP (M365/Entra) refresh: form-encoded grant at the discovered
    // IdP token endpoint (public client). Different surface from AWS SSO OIDC.
    if (authMethod === "external_idp") {
      return this.refreshExternalIdpToken(refreshToken, providerSpecificData);
    }

    // AWS SSO OIDC refresh (Builder ID, IDC, or sso_token import all carry
    // clientId/clientSecret).
    if (clientId && clientSecret) {
      const safeRegion = region || "us-east-1";
      assertValidAwsRegion(safeRegion);
      const endpoint = `https://oidc.${safeRegion}.amazonaws.com/token`;

      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          clientId,
          clientSecret,
          refreshToken,
          grantType: "refresh_token",
        }),
      });

      if (!response.ok) {
        const error = await response.text();
        throw new Error(`Token refresh failed: ${error}`);
      }

      const data = await response.json();
      return {
        accessToken: data.accessToken,
        refreshToken: data.refreshToken || refreshToken,
        profileArn: data.profileArn,
        expiresIn: data.expiresIn,
      };
    }

    // Social auth refresh (Google/GitHub)
    const response = await fetch(`${KIRO_AUTH_SERVICE}/refreshToken`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        refreshToken,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Token refresh failed: ${error}`);
    }

    const data = await response.json();
    return {
      accessToken: data.accessToken,
      refreshToken: data.refreshToken || refreshToken,
      profileArn: data.profileArn,
      expiresIn: data.expiresIn || 3600,
    };
  }

  /**
   * Validate and import refresh token
   */
  async validateImportToken(refreshToken) {
    // Validate token format
    if (!refreshToken.startsWith("aorAAAAAG")) {
      throw new Error("Invalid token format. Token should start with aorAAAAAG...");
    }

    // Try to refresh to validate
    try {
      const result = await this.refreshToken(refreshToken);
      return {
        accessToken: result.accessToken,
        refreshToken: result.refreshToken || refreshToken,
        profileArn: result.profileArn,
        expiresIn: result.expiresIn,
        authMethod: "imported",
      };
    } catch (error) {
      throw new Error(`Token validation failed: ${error.message}`);
    }
  }

  /**
   * List available CodeWhisperer profiles for a token (or API key) and return
   * the best-matching profileArn. AWS SSO OIDC logins return no profileArn, so
   * it must be fetched separately — the same call works for API-key auth.
   * Accepts both `arn` and `profileArn` response field names (the API-key
   * JSON-1.0 surface returns `arn`).
   */
  async listAvailableProfiles(accessToken, region = "us-east-1", options = {}) {
    assertValidAwsRegion(region);
    const endpoint = `https://codewhisperer.${region}.amazonaws.com`;

    // External-IdP (M365/Entra) tokens require TokenType: EXTERNAL_IDP or
    // CodeWhisperer silently returns an empty profile list (helper.py proves
    // this). The KiroIDE User-Agent is also mandatory for these tokens.
    const externalIdp = options.authMethod === "external_idp";
    const machineId = _buildMachineId(accessToken);
    const headers = {
      "Content-Type": "application/x-amz-json-1.0",
      "x-amz-target": "AmazonCodeWhispererService.ListAvailableProfiles",
      "Authorization": `Bearer ${accessToken}`,
      "Accept": "application/json",
      "User-Agent": _kiroUserAgent(machineId),
      "x-amz-user-agent": _kiroxAmzUserAgent(machineId),
    };
    if (externalIdp) headers["TokenType"] = "EXTERNAL_IDP";

    const response = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({ maxResults: 10 }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Failed to list profiles: ${error}`);
    }

    const data = await response.json();
    const profiles = Array.isArray(data?.profiles) ? data.profiles : [];
    const arnOf = (p) => p?.arn || p?.profileArn || null;
    const match = profiles.find((p) => arnOf(p)?.split(":")[3] === region) || profiles[0];
    return arnOf(match);
  }

  /**
   * Validate an API-key credential by listing profiles with it. API keys are
   * long-lived bearer tokens (no refresh), so the only way to validate one is
   * to make an authenticated CodeWhisperer call. Returns a credential object
   * ready to persist as a "kiro" connection with authMethod="api_key".
   */
  async validateApiKey(apiKey, region = "us-east-1") {
    if (!apiKey || typeof apiKey !== "string" || !apiKey.trim()) {
      throw new Error("API key is required");
    }
    const trimmed = apiKey.trim();

    let profileArn = null;
    try {
      profileArn = await this.listAvailableProfiles(trimmed, region);
    } catch (error) {
      throw new Error(`API key validation failed: ${error.message}`);
    }

    return {
      accessToken: trimmed,
      refreshToken: null,
      profileArn,
      region,
      authMethod: "api_key",
    };
  }

  /**
   * List available models from CodeWhisperer API
   */
  async listAvailableModels(accessToken, profileArn) {
    const endpoint = "https://codewhisperer.us-east-1.amazonaws.com";
    const target = "AmazonCodeWhispererService.ListAvailableModels";

    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-amz-json-1.0",
        "x-amz-target": target,
        "Authorization": `Bearer ${accessToken}`,
        "Accept": "application/json",
      },
      body: JSON.stringify({
        origin: "AI_EDITOR",
        profileArn,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Failed to list models: ${error}`);
    }

    const data = await response.json();
    return (data.models || []).map(m => ({
      id: m.modelId,
      name: m.modelName || m.modelId,
      description: m.description,
      rateMultiplier: m.rateMultiplier,
      rateUnit: m.rateUnit,
      maxInputTokens: m.tokenLimits?.maxInputTokens || 0,
    }));
  }

  /**
   * Fetch user email from access token (optional, for display)
   */
  extractEmailFromJWT(accessToken) {
    try {
      const parts = accessToken.split(".");
      if (parts.length !== 3) return null;

      // Decode payload (add padding if needed)
      let payload = parts[1];
      while (payload.length % 4) {
        payload += "=";
      }

      const decoded = JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/")));
      return decoded.email || decoded.preferred_username || decoded.sub;
    } catch {
      return null;
    }
  }

  // --- Enterprise external-IdP (M365/Entra ID/Azure AD) flow ---------------
  // Ported from zsecducna/kiro-login-helper.py. The user opens a hosted
  // app.kiro.dev/signin URL; the portal redirects to a loopback listener
  // (bound in task-3 via utils/server.js) with either:
  //   - an external-IdP descriptor (issuer_url/client_id/scopes/login_hint) ->
  //     we OIDC-discover the IdP, 302 the browser to the IdP authorize endpoint,
  //     and capture the IdP auth code on a second /oauth/callback hit; or
  //   - a Cognito social (Google/GitHub) code -> exchanged at the social token
  //     endpoint.

  /**
   * Generate PKCE + state and build the hosted Kiro sign-in URL the user opens
   * in a browser. Returns everything the loopback callback handler needs to
   * correlate the result. The listener must be bound BEFORE returning this URL.
   */
  startExternalIdpLogin() {
    const codeVerifier = _randomUrlSafe(96);
    const state = _randomUrlSafe(32);
    const codeChallenge = _pkceChallenge(codeVerifier);
    const params = new URLSearchParams({
      state,
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
      redirect_uri: KIRO_EXTERNAL_IDP_LOOPBACK_BASE,
      redirect_from: KIRO_EXTERNAL_IDP_REDIRECT_FROM,
    });
    return {
      signinUrl: `${KIRO_EXTERNAL_IDP_SIGNIN_URL}?${params.toString()}`,
      state,
      codeVerifier,
      codeChallenge,
      redirectUri: KIRO_EXTERNAL_IDP_LOOPBACK_BASE,
    };
  }

  /**
   * Resolve an external-IdP descriptor (leg-1) into an IdP authorize URL to
   * 302 the browser to. Validates the issuer and BOTH discovered endpoints
   * against the .microsoftonline.* allowlist (SSRF guard). Returns the leg-2
   * context to store keyed by the new state.
   */
  async resolveExternalIdpDescriptor({ issuer_url, client_id, scopes, login_hint }) {
    if (!client_id) throw new Error("invalid external IdP descriptor (missing client_id)");
    const issuer = (issuer_url || "").trim();
    const discovered = await _oidcDiscover(issuer);
    const verifier = _randomUrlSafe(96);
    const state2 = _randomUrlSafe(32);
    const redirectUri = KIRO_EXTERNAL_IDP_OAUTH_CALLBACK_URI;
    const authUrl = _externalIdpAuthorizeUrl(
      discovered.authorization_endpoint,
      client_id,
      redirectUri,
      scopes,
      _pkceChallenge(verifier),
      state2,
      login_hint
    );
    return {
      authUrl,
      leg2: {
        state: state2,
        verifier,
        tokenEndpoint: discovered.token_endpoint,
        issuerUrl: issuer,
        clientId: client_id,
        scopes: scopes || "",
        redirectUri,
      },
    };
  }

  /**
   * Exchange an IdP authorization code (leg-2) for IdP tokens, then resolve
   * the CodeWhisperer profile ARN with TokenType: EXTERNAL_IDP. Returns a
   * credential ready to persist with authMethod="external_idp".
   */
  async completeExternalIdpCallback({ code, leg2, region = "us-east-1" }) {
    assertValidAwsRegion(region);
    const tokens = await _exchangeExternalIdpCode(
      leg2.tokenEndpoint,
      leg2.clientId,
      code,
      leg2.verifier,
      leg2.redirectUri,
      leg2.scopes
    );
    let profileArn = tokens.profileArn;
    if (!profileArn) {
      profileArn = await this.listAvailableProfiles(tokens.accessToken, region, {
        authMethod: "external_idp",
      });
    }
    return {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      profileArn,
      expiresIn: tokens.expiresIn,
      authMethod: "external_idp",
      clientId: leg2.clientId,
      tokenEndpoint: leg2.tokenEndpoint,
      issuerUrl: leg2.issuerUrl,
      scopes: leg2.scopes,
      region,
    };
  }

  /**
   * Refresh an external-IdP access token at the discovered IdP token endpoint
   * (form-encoded refresh_token grant, public client). Used by the proactive
   * refresh path; returns the same shape as other refresh paths.
   */
  async refreshExternalIdpToken(refreshToken, providerSpecificData = {}) {
    const tokenEndpoint = providerSpecificData.tokenEndpoint || providerSpecificData.token_endpoint;
    const clientId = providerSpecificData.clientId || providerSpecificData.client_id;
    if (!tokenEndpoint || !clientId) {
      throw new Error("external IdP refresh requires tokenEndpoint and clientId");
    }
    _validateExternalIdpEndpoint(tokenEndpoint);
    const form = new URLSearchParams({
      client_id: clientId,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    });
    if (providerSpecificData.scopes) form.set("scope", providerSpecificData.scopes);
    const response = await fetch(tokenEndpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: form.toString(),
    });
    const data = await response.json().catch(() => null);
    if (!response.ok || !data?.access_token) {
      // Never echo upstream body to the client (SSRF hardening)
      throw new Error("external IdP token refresh failed");
    }
    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token || refreshToken,
      expiresIn: data.expires_in || 3600,
      profileArn: data.profileArn || providerSpecificData.profileArn,
    };
  }

  // --- SSO-token automated import (fallback) -----------------------------
  // Ported from Kiro-Go auth/sso_token.go ImportFromSsoToken. Given an AWS SSO
  // bearer token (x-amz-sso_authn captured from the AWS SSO portal), this
  // drives the device-code flow headlessly: register an OIDC client, start
  // device authorization, validate the bearer token against portal.sso, grab
  // a device session token, accept the user code on the user's behalf,
  // approve the authorization, then poll OIDC /token for the final tokens.
  // Useful when the interactive external-IdP browser flow isn't available.

  async importFromSsoToken(bearerToken, region = "us-east-1") {
    assertValidAwsRegion(region);
    if (!bearerToken || typeof bearerToken !== "string" || !bearerToken.trim()) {
      throw new Error("SSO bearer token is required");
    }
    const oidcBase = `https://oidc.${region}.amazonaws.com`;
    const portalBase = "https://portal.sso.us-east-1.amazonaws.com";
    const startUrl = "https://view.awsapps.com/start";

    // 1. Register OIDC device client.
    const client = await _ssoRegisterDeviceClient(oidcBase, startUrl);
    // 2. Start device authorization.
    const device = await _ssoStartDeviceAuth(oidcBase, client.clientId, client.clientSecret, startUrl);
    // 3. Validate the bearer token.
    await _ssoVerifyBearerToken(portalBase, bearerToken);
    // 4. Get a device session token.
    const deviceSessionToken = await _ssoGetDeviceSessionToken(portalBase, bearerToken);
    // 5. Accept the user code.
    const deviceContext = await _ssoAcceptUserCode(oidcBase, device.userCode, deviceSessionToken);
    // 6. Approve the authorization (only if a device context was returned).
    if (deviceContext) {
      await _ssoApproveAuth(oidcBase, deviceContext, deviceSessionToken);
    }
    // 7. Poll for the final tokens.
    const tokens = await _ssoPollForToken(oidcBase, client.clientId, client.clientSecret, device.deviceCode, device.interval);

    let profileArn = tokens.profileArn;
    if (!profileArn) {
      profileArn = await this.listAvailableProfiles(tokens.accessToken, region);
    }

    return {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      profileArn,
      expiresIn: tokens.expiresIn,
      authMethod: "sso_token",
      clientId: client.clientId,
      clientSecret: client.clientSecret,
      region,
    };
  }

  // --- Import JSON (kiro-login-helper.py output) ---------------------------
  // Accepts the flattened credential JSON produced by kiro-login-helper.py
  // (snake_case: access_token/refresh_token/profile_arn/client_id/
  // token_endpoint/issuer_url/scopes/region/auth_method). Maps it to a 9router
  // connection credential. No network call required — the JSON already carries
  // everything Kiro needs to run. Best path for homelab/remote UIs where the
  // loopback listener can't be reached by the browser.
  importFromJson(rawJson) {
    let data;
    try {
      data = typeof rawJson === "string" ? JSON.parse(rawJson) : rawJson;
    } catch {
      throw new Error("Invalid JSON");
    }
    if (!data || typeof data !== "object") throw new Error("JSON must be an object");
    if (data.type && data.type !== "kiro") {
      throw new Error(`Expected type "kiro", got "${data.type}"`);
    }
    const accessToken = (data.access_token || "").trim();
    const refreshToken = (data.refresh_token || "").trim();
    if (!accessToken || !refreshToken) {
      throw new Error("JSON must contain access_token and refresh_token");
    }
    const region = (data.region || "us-east-1").trim();
    assertValidAwsRegion(region);
    const authMethod = (data.auth_method || "external_idp").trim();
    // Defensive: profileArn must look like an ARN. Without this guard, a bad
    // input could persist the Microsoft client_id (a GUID) into the profileArn
    // field and every Kiro runtime request would fail with 400 Invalid ARN.
    // ARN shape: arn:aws:codewhisperer:<region>:<account>:profile/<id>
    const rawProfileArn = (data.profile_arn || "").trim();
    if (rawProfileArn && !/^arn:aws:codewhisperer:[^:]+:[^:]+:profile\//.test(rawProfileArn)) {
      throw new Error(
        `JSON profile_arn is not a valid CodeWhisperer ARN: ${rawProfileArn}`
      );
    }
    const profileArn = rawProfileArn || null;
    // Validate IdP endpoints when present (SSRF guard, same as the live flow).
    const tokenEndpoint = (data.token_endpoint || "").trim();
    const issuerUrl = (data.issuer_url || "").trim();
    if (tokenEndpoint) _validateExternalIdpEndpoint(tokenEndpoint);
    if (issuerUrl) _validateExternalIdpEndpoint(issuerUrl);
    const expired = data.expired || null;
    let expiresIn = 0;
    if (expired) {
      const ms = Date.parse(expired) - Date.now();
      expiresIn = ms > 0 ? Math.floor(ms / 1000) : 0;
    }
    return {
      accessToken,
      refreshToken,
      profileArn: (data.profile_arn || "").trim() || null,
      expiresIn,
      authMethod,
      clientId: (data.client_id || "").trim() || null,
      clientSecret: (data.client_secret || "").trim() || null,
      tokenEndpoint: tokenEndpoint || null,
      issuerUrl: issuerUrl || null,
      scopes: (data.scopes || "").trim() || null,
      region,
    };
  }

  /**
   * Fetch user email/userId from Kiro's getUsageLimits endpoint. Falls back
   * when the access token isn't a JWT (Kiro-Go GetUserInfo).
   */
  async getUserInfo(accessToken) {
    const url =
      "https://q.us-east-1.amazonaws.com/getUsageLimits?origin=AI_EDITOR&resourceType=AGENTIC_REQUEST&isEmailRequired=true";
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
        "User-Agent": "aws-sdk-js/1.0.18 KiroAPIProxy",
        "x-amz-user-agent": "aws-sdk-js/1.0.18 KiroAPIProxy",
      },
    });
    if (!response.ok) return { email: null, userId: null };
    const data = await response.json().catch(() => ({}));
    return {
      email: data?.userInfo?.email || null,
      userId: data?.userInfo?.userId || null,
    };
  }
}

// --- external-IdP module-level helpers (pure functions over fetch/crypto) ----

function _randomUrlSafe(n) {
  return _cryptoRandomBytes(n).toString("base64url");
}

function _pkceChallenge(verifier) {
  return createHash("sha256").update(verifier).digest("base64url");
}

/**
 * Validate an external-IdP endpoint URL: https, non-IP host, allowlisted suffix.
 * Anchored on a real subdomain boundary (leading dot) so
 * evil-microsoftonline.com cannot match. Throws on any failure.
 */
function _validateExternalIdpEndpoint(rawUrl) {
  let parsed;
  try {
    parsed = new URL((rawUrl || "").trim());
  } catch {
    throw new Error("external IdP URL is invalid");
  }
  if (parsed.protocol.toLowerCase() !== "https:") {
    throw new Error("external IdP URL must be https");
  }
  const host = (parsed.hostname || "").toLowerCase();
  if (!host) throw new Error("external IdP URL has no host");
  // Reject IP-literal hosts.
  if (_isIpLiteral(host)) {
    throw new Error("external IdP host must not be an IP literal");
  }
  for (const suffix of ALLOWED_EXTERNAL_IDP_SUFFIXES) {
    if (host.endsWith(suffix)) return; // valid
  }
  throw new Error("external IdP host is not allow-listed");
}

function _isIpLiteral(host) {
  // IPv6 in URL is bracketed; URL.hostname strips brackets. Check both.
  if (host.includes(":")) return true; // IPv6
  return /^(\d{1,3}\.){3}\d{1,3}$/.test(host); // IPv4
}

async function _oidcDiscover(issuerUrl) {
  _validateExternalIdpEndpoint(issuerUrl);
  const docUrl = issuerUrl.trim().replace(/\/+$/, "") + "/.well-known/openid-configuration";
  // No-follow-redirects would need a custom dispatcher; fetch follows redirects
  // by default. ponytail: if an IdP ever bounces discovery to an internal host,
  // switch to undici's redirect: 'manual' + re-validate each Location.
  const response = await fetch(docUrl, {
    headers: { Accept: "application/json" },
    redirect: "error",
  });
  if (!response.ok) throw new Error("OIDC discovery fetch failed");
  const doc = await response.json();
  const authorization_endpoint = (doc.authorization_endpoint || "").trim();
  const token_endpoint = (doc.token_endpoint || "").trim();
  if (!authorization_endpoint || !token_endpoint) {
    throw new Error("OIDC discovery missing authorization_endpoint or token_endpoint");
  }
  _validateExternalIdpEndpoint(authorization_endpoint);
  _validateExternalIdpEndpoint(token_endpoint);
  return { authorization_endpoint, token_endpoint };
}

function _externalIdpAuthorizeUrl(authEndpoint, clientId, redirectUri, scopes, challenge, state, loginHint) {
  const q = new URLSearchParams({
    client_id: clientId,
    response_type: "code",
    redirect_uri: redirectUri,
    code_challenge: challenge,
    code_challenge_method: "S256",
    response_mode: "query",
    state,
  });
  if (scopes) q.set("scope", scopes);
  if (loginHint && loginHint.trim()) q.set("login_hint", loginHint.trim());
  return `${authEndpoint}?${q.toString()}`;
}

async function _exchangeExternalIdpCode(tokenEndpoint, clientId, code, verifier, redirectUri, scopes) {
  _validateExternalIdpEndpoint(tokenEndpoint);
  const form = new URLSearchParams({
    client_id: clientId,
    grant_type: "authorization_code",
    code: code.trim(),
    redirect_uri: redirectUri,
    code_verifier: verifier,
  });
  if (scopes) form.set("scope", scopes);
  const response = await fetch(tokenEndpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: form.toString(),
  });
  const data = await response.json().catch(() => null);
  if (!response.ok || !data?.access_token) {
    throw new Error("external IdP token exchange failed");
  }
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token || "",
    expiresIn: parseInt(data.expires_in || "0", 10),
    profileArn: "", // external IdP issues no profile ARN; resolved separately
  };
}

// --- SSO-token (portal.sso) helpers ------------------------------------------
// Mirror Kiro-Go auth/sso_token.go. These talk to the AWS SSO portal + OIDC
// endpoints to headlessly complete a device-code flow using a bearer token
// the user captured from the AWS SSO portal. All errors are generic (no
// upstream body echo) to avoid leaking portal responses.

const KIRO_SSO_SCOPES = [
  "codewhisperer:completions",
  "codewhisperer:analysis",
  "codewhisperer:conversations",
  "codewhisperer:transformations",
  "codewhisperer:taskassist",
];

async function _ssoRegisterDeviceClient(oidcBase, startUrl) {
  const response = await fetch(`${oidcBase}/client/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      clientName: "Kiro API Proxy",
      clientType: "public",
      scopes: KIRO_SSO_SCOPES,
      grantTypes: ["urn:ietf:params:oauth:grant-type:device_code", "refresh_token"],
      issuerUrl: startUrl,
    }),
  });
  if (!response.ok) throw new Error("SSO client registration failed");
  const data = await response.json();
  return { clientId: data.clientId, clientSecret: data.clientSecret };
}

async function _ssoStartDeviceAuth(oidcBase, clientId, clientSecret, startUrl) {
  const response = await fetch(`${oidcBase}/device_authorization`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ clientId, clientSecret, startUrl }),
  });
  if (!response.ok) throw new Error("SSO device authorization failed");
  const data = await response.json();
  return {
    deviceCode: data.deviceCode,
    userCode: data.userCode,
    interval: data.interval || 1,
  };
}

async function _ssoVerifyBearerToken(portalBase, bearerToken) {
  const response = await fetch(`${portalBase}/token/whoAmI`, {
    headers: { Authorization: `Bearer ${bearerToken}`, Accept: "application/json" },
  });
  if (!response.ok) throw new Error("SSO bearer token verification failed");
}

async function _ssoGetDeviceSessionToken(portalBase, bearerToken) {
  const response = await fetch(`${portalBase}/session/device`, {
    method: "POST",
    headers: { Authorization: `Bearer ${bearerToken}`, "Content-Type": "application/json" },
    body: "{}",
  });
  if (!response.ok) throw new Error("SSO device session creation failed");
  const data = await response.json();
  return data.token;
}

async function _ssoAcceptUserCode(oidcBase, userCode, deviceSessionToken) {
  const response = await fetch(`${oidcBase}/device_authorization/accept_user_code`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Referer: "https://view.awsapps.com/" },
    body: JSON.stringify({ userCode, userSessionId: deviceSessionToken }),
  });
  if (!response.ok) throw new Error("SSO accept_user_code failed");
  const data = await response.json();
  return data.deviceContext || null;
}

async function _ssoApproveAuth(oidcBase, deviceContext, deviceSessionToken) {
  const response = await fetch(`${oidcBase}/device_authorization/associate_token`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Referer: "https://view.awsapps.com/" },
    body: JSON.stringify({
      deviceContext: {
        deviceContextId: deviceContext.deviceContextId,
        clientId: deviceContext.clientId,
        clientType: deviceContext.clientType,
      },
      userSessionId: deviceSessionToken,
    }),
  });
  if (!response.ok) throw new Error("SSO associate_token failed");
}

async function _ssoPollForToken(oidcBase, clientId, clientSecret, deviceCode, interval) {
  const payload = { clientId, clientSecret, grantType: "urn:ietf:params:oauth:grant-type:device_code", deviceCode };
  const deadline = Date.now() + 2 * 60 * 1000;
  let wait = (interval || 1) * 1000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, wait));
    const response = await fetch(`${oidcBase}/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await response.json().catch(() => null);
    if (response.ok && data?.accessToken) {
      return {
        accessToken: data.accessToken,
        refreshToken: data.refreshToken,
        expiresIn: data.expiresIn,
        profileArn: data.profileArn || null,
      };
    }
    const err = data?.error || "";
    if (err === "authorization_pending") continue;
    if (err === "slow_down") { wait += 5000; continue; }
    throw new Error(`SSO token poll failed: ${err || response.status}`);
  }
  throw new Error("SSO token poll timed out");
}
