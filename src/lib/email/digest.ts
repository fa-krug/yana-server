import { createTranslator } from "use-intl/core";

import type { AppLocale } from "../../i18n/locale";

export interface ErrorEntry {
  category: "worker" | "scheduler" | "job";
  message: string;
  occurredAt: Date;
  jobKind?: string;
}

/**
 * Renders one recipient's digest of everything bundled into a single
 * notification window. There is no request here to call next-intl's
 * `getTranslations()` from -- this runs from a worker loop, a scheduler tick,
 * or a job's terminal failure -- so the catalog is loaded the same way
 * `src/i18n/request.ts` loads it for the root layout, and `createTranslator`
 * (`use-intl/core`) renders against it directly.
 */
export async function renderDigest(
  locale: AppLocale,
  entries: ErrorEntry[],
): Promise<{ subject: string; body: string }> {
  const messages = (await import(`../../../messages/${locale}.json`)).default;
  const t = createTranslator({ locale, messages, namespace: "email" });

  const lines = entries.map((entry) => {
    const time = entry.occurredAt.toISOString();
    if (entry.category === "worker") {
      return t("workerEntry", { time, message: entry.message });
    }
    if (entry.category === "scheduler") {
      return t("schedulerEntry", { time, message: entry.message });
    }
    return t("jobEntry", { time, message: entry.message, jobKind: entry.jobKind ?? "" });
  });

  return {
    subject: t("subject", { count: entries.length }),
    body: `${t("intro")}\n\n${lines.join("\n")}`,
  };
}
