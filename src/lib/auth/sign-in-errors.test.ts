import { BASE_ERROR_CODES } from "better-auth";
import { describe, expect, it } from "vitest";

import en from "../../../messages/en.json";

import { passkeyErrorKey, passwordErrorKey } from "./sign-in-errors";

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
