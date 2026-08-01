import { mask } from "@/lib/secrets";
import { getSettings } from "@/lib/settings/queries";

/**
 * Reads for `/integrations`. Writes are in `./actions`.
 *
 * **SERVER-ONLY**, and enforced rather than documented: a component importing
 * any feature's `queries` module is an ESLint `no-restricted-imports`
 * error (see `eslint.config.mjs`), because this module reaches `getDb()` through
 * `getSettings()` and one constant taken from here would drag `better-sqlite3`
 * into the browser bundle. The page calls this and passes the projection down as
 * props; the sections never import it.
 *
 * **The projection is the security boundary, not a convention.** A secret that
 * reaches a client component is in the RSC payload of the page, which is plain
 * text in the browser's network tab and in view-source -- so
 * {@link getIntegrationStatus} is typed to carry *no* field that could hold one:
 * every credential is passed through `mask()` and the type says `...Masked`. A
 * later phase adding a provider adds a masked field, never a raw one.
 *
 * `getSettings()` rather than a second `SELECT`: it is the same row the root
 * layout already read for this request (locale and theme) and it is `cache()`d,
 * so the page costs no extra query. Its throw on a missing `user_settings` row
 * is inherited on purpose -- that is a provisioning bug, and this read must not
 * self-heal (CLAUDE.md). Identity, and therefore the scope of the read, comes
 * from the session inside it: `currentUserId()` -> `requireUser()`.
 */

/** Everything `/integrations` renders. No raw secret can be expressed here. */
export type IntegrationStatus = {
  youtube: {
    enabled: boolean;
    /** `""` when nothing is stored, else eight bullets and the last four characters. */
    apiKeyMasked: string;
  };
  reddit: {
    enabled: boolean;
    clientIdMasked: string;
    clientSecretMasked: string;
    /**
     * Plaintext, deliberately: a User-Agent is not a credential -- it is sent to
     * Reddit on every request and is meant to identify this installation
     * publicly. Masking it would make the one field an operator most often needs
     * to correct unreadable.
     */
    userAgent: string;
  };
};

export async function getIntegrationStatus(): Promise<IntegrationStatus> {
  const settings = await getSettings();

  return {
    youtube: {
      enabled: settings.youtubeEnabled,
      apiKeyMasked: mask(settings.youtubeApiKey),
    },
    reddit: {
      enabled: settings.redditEnabled,
      clientIdMasked: mask(settings.redditClientId),
      clientSecretMasked: mask(settings.redditClientSecret),
      userAgent: settings.redditUserAgent,
    },
  };
}
