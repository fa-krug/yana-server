import type { UserSettings } from "@/lib/db/schema";
import { mask } from "@/lib/secrets";
import { getSettings } from "@/lib/settings/queries";

import { AI_COLUMNS, providersWithColumns, resolveModel } from "./columns";
import type { AiProviderKey } from "./providers";
import { providerByKey } from "./providers";

/**
 * Reads for `/ai`. Writes are in `./actions`.
 *
 * **SERVER-ONLY**, and enforced rather than documented: a component importing
 * any feature's `queries` module is an ESLint `no-restricted-imports` error (see
 * `eslint.config.mjs`), because this module reaches `getDb()` through
 * `getSettings()` and one constant taken from here would drag `better-sqlite3`
 * into the browser bundle. The page calls this and passes the projection down as
 * props; the sections never import it.
 *
 * **The projection is the security boundary, not a convention.** A client
 * component's props are the page's RSC payload, which is plain text in a
 * browser's network tab and in view-source -- so {@link AiStatus} is typed to
 * carry *no* field that could hold a raw secret: every API key goes through
 * `mask()` and the field is named `apiKeyMasked`. A later phase adding a
 * provider adds a masked field, never a raw one, and never "just for a moment".
 *
 * `getSettings()` rather than a second `SELECT`: it is the same row the root
 * layout already read for this request (locale and theme) and it is `cache()`d,
 * so the page costs no extra query. Its throw on a missing `user_settings` row
 * is inherited on purpose -- that is a provisioning bug, and this read must not
 * self-heal (CLAUDE.md). Identity, and therefore the scope of the read, comes
 * from the session inside it: `currentUserId()` -> `requireUser()`.
 */

/** One provider's card, as `/ai` renders it. No raw secret can be expressed here. */
export type AiProviderStatus = {
  /** Probe-derived, never request-derived. */
  enabled: boolean;
  /** `""` when nothing is stored, else eight bullets and the last four characters. */
  apiKeyMasked: string;
  /**
   * The provider's base URL, or `""` for the two whose endpoint is fixed
   * (`hasCustomUrl === false`). Plaintext, deliberately: it is an operator
   * setting, not a credential, and masking the one field an operator most often
   * needs to correct would make it unreadable.
   */
  apiUrl: string;
  /**
   * Always a model the provider's registry entry still offers -- see
   * {@link resolveModel}. A stored id absent from the list would make the
   * collapsed `<Select>` trigger print the raw id.
   */
  model: string;
};

/**
 * The nine global tuning values, **without the `ai` prefix the columns carry**
 * (`aiTemperature` -> `temperature`). That renaming happens here and nowhere
 * else: the form, the action's zod schema and this projection all speak the
 * short names, and `./actions` owns the one map back to columns.
 */
export type AiAdvanced = {
  temperature: number;
  maxTokens: number;
  dailyLimit: number;
  monthlyLimit: number;
  maxPromptLength: number;
  requestTimeout: number;
  maxRetries: number;
  retryDelay: number;
  requestDelay: number;
};

export type AiStatus = {
  /**
   * The provider AI actually runs on, or `""` for none.
   *
   * **Derived, not read straight out of the column.** `active_ai_provider` is a
   * preference; a provider is only active if its probe-derived `*Enabled` flag
   * agrees. `./actions` already clears the column on the two paths that can
   * switch a flag off, so this normally reports the stored value unchanged -- but
   * those are two writes rather than one, and the column is also reachable by a
   * hand-edited database, a future phase that flips a flag without going through
   * these actions, or an import. Deriving makes the dangling state unobservable
   * instead of merely unlikely, which is the same argument `safeAvatarSrc()`
   * rests on: check the value you are about to *use*.
   *
   * Getting this wrong is the silent failure the whole page exists to prevent --
   * a badge reading "Active" over a provider that cannot answer, and summaries
   * that never appear with nothing in the UI to say why.
   */
  active: AiProviderKey | "";
  providers: Record<AiProviderKey, AiProviderStatus>;
  advanced: AiAdvanced;
};

/** Is the provider this key names switched on in this row? */
export function providerEnabled(settings: UserSettings, key: AiProviderKey): boolean {
  return settings[AI_COLUMNS[key].enabled];
}

/** {@link AiStatus.active}: the stored preference, but only if its flag agrees. */
export function activeProvider(settings: UserSettings): AiProviderKey | "" {
  const provider = providerByKey(settings.activeAiProvider);
  return provider && providerEnabled(settings, provider.key) ? provider.key : "";
}

export async function getAiStatus(): Promise<AiStatus> {
  const settings = await getSettings();

  // Built by walking the registry rather than by writing three literal blocks:
  // a fourth provider is then an entry in `AI_PROVIDERS` plus one in
  // `AI_COLUMNS`, and there is no third place to forget.
  const providers = {} as Record<AiProviderKey, AiProviderStatus>;
  for (const { provider, columns } of providersWithColumns()) {
    providers[provider.key] = {
      enabled: settings[columns.enabled],
      apiKeyMasked: mask(settings[columns.apiKey]),
      // `hasCustomUrl` is the declared fact and the column follows it; a
      // provider with a fixed endpoint has nothing to show and no field to show
      // it in.
      apiUrl: columns.apiUrl ? settings[columns.apiUrl] : "",
      model: resolveModel(provider, settings[columns.model]),
    };
  }

  return {
    active: activeProvider(settings),
    providers,
    advanced: {
      temperature: settings.aiTemperature,
      maxTokens: settings.aiMaxTokens,
      dailyLimit: settings.aiDefaultDailyLimit,
      monthlyLimit: settings.aiDefaultMonthlyLimit,
      maxPromptLength: settings.aiMaxPromptLength,
      requestTimeout: settings.aiRequestTimeout,
      maxRetries: settings.aiMaxRetries,
      retryDelay: settings.aiRetryDelay,
      requestDelay: settings.aiRequestDelay,
    },
  };
}
