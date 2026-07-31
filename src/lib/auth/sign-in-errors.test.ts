import type { WebAuthnErrorCode } from "@simplewebauthn/browser";
import { BASE_ERROR_CODES } from "better-auth";
import { describe, expect, it } from "vitest";

import en from "../../../messages/en.json";

import {
  NETWORK_FAILURE,
  PASSKEY_ALREADY_REGISTERED_CODE,
  passkeyErrorKey,
  passwordErrorKey,
} from "./sign-in-errors";

/** Every value these two functions can return has to exist in the catalogs. */
function resolves(key: string): boolean {
  return Object.hasOwn(en.auth, key);
}

describe("passwordErrorKey", () => {
  it("names the wrong-credentials case, using the code Better Auth actually sends", () => {
    // Not a hand-written string: BASE_ERROR_CODES is the library's own table,
    // so a rename there fails this test instead of silently downgrading every
    // bad password to the generic message. defineErrorCodes() keys the table
    // by the code, which is what APIError.from() puts on the wire.
    const error = { code: "INVALID_EMAIL_OR_PASSWORD", status: 401 };

    expect(Object.hasOwn(BASE_ERROR_CODES, error.code)).toBe(true);
    expect(passwordErrorKey(error)).toBe("invalidCredentials");
  });

  it.each([
    ["an unmapped code", { code: "FAILED_TO_CREATE_SESSION", status: 500 }],
    ["no code at all", { status: 500, message: "Internal Server Error" }],
    ["nothing", null],
  ])("falls back to the generic failure for %s", (_case, error) => {
    expect(passwordErrorKey(error)).toBe("signInFailed");
  });
});

describe("passkeyErrorKey", () => {
  it.each([
    // What @better-auth/passkey's client returns when the ceremony threw
    // anything that is not a WebAuthnError -- a dismissed dialog, above all.
    ["AUTH_CANCELLED"],
    // SimpleWebAuthn's WebAuthnError codes, passed through verbatim. The
    // browser will not say whether the user cancelled or has no credential for
    // this site, so neither does the message.
    ["ERROR_CEREMONY_ABORTED"],
    ["ERROR_PASSTHROUGH_SEE_CAUSE_PROPERTY"],
  ])("tells the user to use a password when the passkey did not happen (%s)", (code) => {
    expect(passkeyErrorKey({ code, status: 400 })).toBe("passkeyUnavailable");
  });

  it("falls back to the generic failure for a server-side error", () => {
    expect(passkeyErrorKey({ code: "UNAUTHORIZED", status: 401 })).toBe("signInFailed");
    expect(passkeyErrorKey({ status: 500 })).toBe("signInFailed");
  });

  /**
   * **Pinned to the library's own union, not to a list typed out here.**
   *
   * `passkeyErrorKey()` matches on the `ERROR_` *prefix* rather than on named
   * codes, which is only sound while every member of
   * `WebAuthnErrorCode` carries it -- and that union belongs to
   * `@simplewebauthn/browser`, which `@better-auth/passkey` passes through
   * verbatim (`code: err instanceof WebAuthnError ? err.code : "AUTH_CANCELLED"`).
   *
   * The assignment below is the assertion: a release that added, say,
   * `WEBAUTHN_TIMEOUT` would make it stop compiling, so `npm run typecheck`
   * catches the drift rather than a user meeting the wrong message. Task 6's
   * live ceremony confirmed the other half empirically -- Chrome's real
   * `NotAllowedError` reaches `identifyAuthenticationError()`, comes back as
   * `ERROR_PASSTHROUGH_SEE_CAUSE_PROPERTY`, and lands on `passkeyUnavailable`.
   */
  it("covers every code the library can produce", () => {
    const everyCodeStartsWithTheMatchedPrefix: `ERROR_${string}` =
      null as unknown as WebAuthnErrorCode;
    void everyCodeStartsWithTheMatchedPrefix;

    // And the runtime half, over the codes as of @simplewebauthn/browser 13.3.0.
    const codes: WebAuthnErrorCode[] = [
      "ERROR_CEREMONY_ABORTED",
      "ERROR_INVALID_DOMAIN",
      "ERROR_INVALID_RP_ID",
      "ERROR_INVALID_USER_ID_LENGTH",
      "ERROR_MALFORMED_PUBKEYCREDPARAMS",
      "ERROR_AUTHENTICATOR_GENERAL_ERROR",
      "ERROR_AUTHENTICATOR_MISSING_DISCOVERABLE_CREDENTIAL_SUPPORT",
      "ERROR_AUTHENTICATOR_MISSING_USER_VERIFICATION_SUPPORT",
      "ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED",
      "ERROR_AUTHENTICATOR_NO_SUPPORTED_PUBKEYCREDPARAMS_ALG",
      "ERROR_AUTO_REGISTER_USER_VERIFICATION_FAILURE",
      "ERROR_PASSTHROUGH_SEE_CAUSE_PROPERTY",
    ];

    for (const code of codes) {
      expect(passkeyErrorKey({ code, status: 400 })).toBe("passkeyUnavailable");
    }
  });
});

describe("PASSKEY_ALREADY_REGISTERED_CODE", () => {
  it("is a real member of the library's union", () => {
    // The annotation is the assertion: a rename in @simplewebauthn/browser
    // stops this compiling instead of silently downgrading the account page's
    // "this device already has a passkey" to "no passkey was created".
    const pinned: WebAuthnErrorCode = PASSKEY_ALREADY_REGISTERED_CODE;

    expect(pinned).toBe("ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED");
  });

  it("is exactly the code the prefix mapper would swallow", () => {
    // Which is why registration tests it *before* calling the mapper: on its
    // own, passkeyErrorKey() cannot tell it from a dismissed dialog.
    expect(passkeyErrorKey({ code: PASSKEY_ALREADY_REGISTERED_CODE })).toBe("passkeyUnavailable");
  });
});

describe("NETWORK_FAILURE", () => {
  it("is a generic failure on both paths", () => {
    // The request never reached the server, so there is nothing specific to
    // say -- "try again" is the correct advice, and it must not be mistaken for
    // wrong credentials or a missing passkey.
    expect(passwordErrorKey(NETWORK_FAILURE)).toBe("signInFailed");
    expect(passkeyErrorKey(NETWORK_FAILURE)).toBe("signInFailed");
  });

  it("does not collide with a real Better Auth code", () => {
    expect(Object.hasOwn(BASE_ERROR_CODES, NETWORK_FAILURE.code ?? "")).toBe(false);
  });
});

describe("the keys these functions produce", () => {
  it("all exist in the catalogs", () => {
    // The compiler already holds them to `NamespaceKey<"auth">` (see
    // src/i18n/next-intl.d.ts), but that check lives in a .d.ts augmentation
    // that is easy to break without noticing; this one runs.
    const keys = [
      passwordErrorKey({ code: "INVALID_EMAIL_OR_PASSWORD" }),
      passwordErrorKey({}),
      passkeyErrorKey({ code: "AUTH_CANCELLED" }),
      passkeyErrorKey({}),
    ];

    expect(keys.every(resolves)).toBe(true);
  });

  it("never returns a Better Auth message", () => {
    // The defect this whole module exists to prevent: `error.message` is an
    // English constant in the library, and putting it in a toast would show
    // English to a German UI.
    const message = BASE_ERROR_CODES.INVALID_EMAIL_OR_PASSWORD.message;

    expect(message).toBe("Invalid email or password");
    expect(en.auth.invalidCredentials).not.toBe(message);
    expect(passwordErrorKey({ code: "INVALID_EMAIL_OR_PASSWORD", message })).toBe(
      "invalidCredentials",
    );
  });
});
