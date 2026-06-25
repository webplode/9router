"use client";

import { useState, useEffect, useRef } from "react";
import PropTypes from "prop-types";
import { Modal, Button, Input } from "@/shared/components";
import { useCopyToClipboard } from "@/shared/hooks/useCopyToClipboard";

/**
 * Kiro Enterprise (M365 / Entra ID) — manual callback paste flow.
 * Works when UI is on homelab-alma (no localhost:3128 listener required).
 */
export default function KiroExternalIdpOAuthModal({ isOpen, onSuccess, onClose }) {
  const [step, setStep] = useState("loading"); // loading | leg1 | leg2 | success | error
  const [signinUrl, setSigninUrl] = useState("");
  const [idpAuthUrl, setIdpAuthUrl] = useState("");
  const [sessionToken, setSessionToken] = useState("");
  const [callbackUrl, setCallbackUrl] = useState("");
  const [error, setError] = useState(null);
  const { copied, copy } = useCopyToClipboard();
  const openedRef = useRef(false);

  useEffect(() => {
    if (!isOpen) openedRef.current = false;
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    const init = async () => {
      try {
        setError(null);
        setStep("loading");
        const res = await fetch("/api/oauth/kiro/external-idp/signin-url");
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Failed to load sign-in URL");
        setSigninUrl(data.signinUrl);
        setStep("leg1");
        if (!openedRef.current) {
          openedRef.current = true;
          window.open(data.signinUrl, "_blank");
        }
      } catch (err) {
        setError(err.message);
        setStep("error");
      }
    };
    init();
  }, [isOpen]);

  const submitLeg1 = async () => {
    try {
      setError(null);
      const res = await fetch("/api/oauth/kiro/external-idp/complete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ callbackUrl: callbackUrl.trim() }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed");
      if (data.step !== "idp") throw new Error("Expected Microsoft login step");
      setSessionToken(data.sessionToken);
      setIdpAuthUrl(data.authUrl);
      setCallbackUrl("");
      setStep("leg2");
      window.open(data.authUrl, "_blank");
    } catch (err) {
      setError(err.message);
      setStep("error");
    }
  };

  const submitLeg2 = async () => {
    try {
      setError(null);
      const res = await fetch("/api/oauth/kiro/external-idp/complete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          callbackUrl: callbackUrl.trim(),
          sessionToken,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed");
      if (data.step !== "done") throw new Error("Sign-in did not complete");
      setStep("success");
      onSuccess?.();
    } catch (err) {
      setError(err.message);
      setStep("error");
    }
  };

  return (
    <Modal isOpen={isOpen} title="Connect Kiro — Microsoft 365 / Entra ID" onClose={onClose} size="lg">
      <div className="flex flex-col gap-4">
        {step === "loading" && (
          <div className="text-center py-6">
            <span className="material-symbols-outlined text-3xl text-primary animate-spin">progress_activity</span>
            <p className="text-sm text-text-muted mt-2">Preparing sign-in…</p>
          </div>
        )}

        {step === "leg1" && (
          <>
            <div className="bg-blue-50 dark:bg-blue-900/20 p-3 rounded-lg border border-blue-200 dark:border-blue-800 text-sm">
              After Kiro sign-in, the browser may try <code className="text-xs">localhost:3128</code> and fail — that is
              normal on <strong>homelab-alma</strong>. Copy the <strong>full URL</strong> from the address bar and paste it below.
            </div>
            <div>
              <p className="text-sm font-medium mb-2">Step 1: Open Kiro sign-in (guest/incognito recommended)</p>
              <div className="flex gap-2">
                <Input value={signinUrl} readOnly className="flex-1 font-mono text-xs" />
                <Button variant="secondary" icon={copied === "signin" ? "check" : "content_copy"} onClick={() => copy(signinUrl, "signin")}>
                  Copy
                </Button>
              </div>
            </div>
            <div>
              <p className="text-sm font-medium mb-2">Step 2: Paste first callback URL</p>
              <p className="text-xs text-text-muted mb-2">
                URL contains <code>signin/callback</code> and <code>login_option=external_idp</code> (or <code>issuer_url</code>).
              </p>
              <Input
                value={callbackUrl}
                onChange={(e) => setCallbackUrl(e.target.value)}
                placeholder="http://localhost:3128/signin/callback?login_option=external_idp&..."
                className="font-mono text-xs"
              />
            </div>
            <div className="flex gap-2">
              <Button onClick={submitLeg1} fullWidth disabled={!callbackUrl.trim()}>
                Continue to Microsoft login
              </Button>
              <Button onClick={onClose} variant="ghost" fullWidth>
                Cancel
              </Button>
            </div>
          </>
        )}

        {step === "leg2" && (
          <>
            <div>
              <p className="text-sm font-medium mb-2">Step 3: Sign in at Microsoft (opened in new tab)</p>
              <div className="flex gap-2">
                <Input value={idpAuthUrl} readOnly className="flex-1 font-mono text-xs" />
                <Button variant="secondary" icon={copied === "idp" ? "check" : "content_copy"} onClick={() => copy(idpAuthUrl, "idp")}>
                  Copy
                </Button>
              </div>
            </div>
            <div>
              <p className="text-sm font-medium mb-2">Step 4: Paste second callback URL</p>
              <p className="text-xs text-text-muted mb-2">
                After Microsoft login, paste the URL with <code>/oauth/callback?code=...</code>
              </p>
              <Input
                value={callbackUrl}
                onChange={(e) => setCallbackUrl(e.target.value)}
                placeholder="http://localhost:3128/oauth/callback?code=...&state=..."
                className="font-mono text-xs"
              />
            </div>
            <div className="flex gap-2">
              <Button onClick={submitLeg2} fullWidth disabled={!callbackUrl.trim()}>
                Connect
              </Button>
              <Button onClick={onClose} variant="ghost" fullWidth>
                Cancel
              </Button>
            </div>
          </>
        )}

        {step === "success" && (
          <div className="text-center py-6">
            <span className="material-symbols-outlined text-3xl text-green-600">check_circle</span>
            <h3 className="text-lg font-semibold mt-2">Connected</h3>
            <Button onClick={onClose} fullWidth className="mt-4">
              Done
            </Button>
          </div>
        )}

        {step === "error" && (
          <div className="text-center py-6">
            <p className="text-sm text-red-600 mb-4">{error}</p>
            <div className="flex gap-2">
              <Button onClick={() => { setError(null); setStep(sessionToken ? "leg2" : "leg1"); }} variant="secondary" fullWidth>
                Try again
              </Button>
              <Button onClick={onClose} variant="ghost" fullWidth>
                Cancel
              </Button>
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}

KiroExternalIdpOAuthModal.propTypes = {
  isOpen: PropTypes.bool.isRequired,
  onSuccess: PropTypes.func,
  onClose: PropTypes.func.isRequired,
};