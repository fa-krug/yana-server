import { getRequestConfig } from "next-intl/server";

import { getSettings } from "@/lib/settings/queries";

export default getRequestConfig(async () => {
  // Locale comes from the user's stored preference, not from Accept-Language:
  // this is a single-user-per-session app where the setting is explicit.
  const settings = await getSettings();
  const locale = settings.language === "de" ? "de" : "en";
  return { locale, messages: (await import(`../../messages/${locale}.json`)).default };
});
