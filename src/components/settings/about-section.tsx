import { useTranslations } from "next-intl";

// Verified against this checkout's `git remote -v`.
const REPO = "https://github.com/fa-krug/yana-server";

export function AboutSection() {
  const t = useTranslations("settings");
  return (
    <section className="space-y-2">
      <h2 className="text-lg font-medium">{t("about.title")}</h2>
      <ul className="space-y-1 text-sm">
        <li>
          <a className="underline" href={REPO} target="_blank" rel="noreferrer noopener">
            {t("about.source")}
          </a>
        </li>
        <li>
          <a
            className="underline"
            href={`${REPO}/issues`}
            target="_blank"
            rel="noreferrer noopener"
          >
            {t("about.issues")}
          </a>
        </li>
      </ul>
    </section>
  );
}
