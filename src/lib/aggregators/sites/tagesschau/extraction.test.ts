import * as cheerio from "cheerio";
import { describe, expect, it } from "vitest";

import { extractTagesschauContent, isBr24Page } from "./extraction";

/**
 * Trimmed from the page `https://www.tagesschau.de/inland/oktoberfest-unfall-104.html`
 * redirects to (a `br.de/nachrichten/...` article), keeping every module the
 * generic fallback used to pick up instead of the body: the hero image label,
 * its caption and credit, the tag list, the related-articles rail, and the
 * promotions BR24 appends as ordinary rich text.
 */
const BR24_PAGE = `<html><body><main><article class="Article-module-scss-module__3A8Kya__article">
  <header>
    <div class="ArticleModuleHero-module-scss-module__cHojSq__wrapper">Bild<figure><img src="https://img.br.de/hero.jpeg"></figure></div>
    <div class="ArticleModuleMediaCollapsibleMetadataBox-module-scss-module__3LyyUq__wrapper">Bildrechte: Lea Nischelwitzer / Bayerischer Rundfunk 2026
      <p class="ArticleModuleMediaCollapsibleMetadataBox-module-scss-module__3LyyUq__caption">Eindrücke vom Unfallort</p></div>
    <section class="ArticleModuleTeaser-module-scss-module__Y44zPW__wrapper">
      <h2 class="heading1 ArticleModuleTeaser-module-scss-module__Y44zPW__title">Unfall auf Oktoberfest: Mitarbeiter tödlich verunglückt </h2>
      <p class="body3 ArticleItemTeaserText-module-scss-module__A6SG_q__text">Ein Mitarbeiter ist ums Leben gekommen.</p>
      <p class="ArticleModuleSourceOrigin-module-scss-module__7ARJoa__sourceOrigin">Über dieses Thema berichtet: BR24</p>
    </section>
  </header>
  <section class="ArticleBody-module-scss-module__oQZvRW__section">
    <section class="ArticleModuleText-module-scss-module__RqtLyq__wrapper"><div class="RichText-module-scss-module__ZDJi6a__richText body3">
      <ul><li><a href="https://www.br.de/a"><b>Direkt zum aktuellen Artikel: Fahrgeschäft technisch einwandfrei</b></a></li></ul>
      <p>Bei einem Unfall ist ein <a href="https://www.br.de/wiesn">Mitarbeiter</a> tödlich verunglückt.</p>
      <ul><li>Zum Artikel: <a href="https://www.br.de/b">Polizei sucht Zeugen</a></li></ul>
      <h2>Ermittlungen laufen</h2>
      <p>Der Bereich wurde abgeriegelt.</p>
      <ul><li>Erster Punkt</li><li>Zweiter Punkt</li></ul>
      <p><em>Mit Informationen von dpa.</em></p>
    </div></section>
    <section class="ArticleModuleText-module-scss-module__RqtLyq__wrapper"><div class="RichText-module-scss-module__ZDJi6a__richText body3">
      <h2>Video: Schwerer Unfall auf dem Oktoberfest</h2>
    </div></section>
    <section class="SectionStyles-module-scss-module__MMPk4W__section"><figure><img src="https://img.br.de/video.jpeg"></figure>
      <p class="ArticleModuleMediaCollapsibleMetadataBox-module-scss-module__3LyyUq__caption">Schwerer Unfall</p></section>
    <section class="ArticleModuleText-module-scss-module__RqtLyq__wrapper"><div class="RichText-module-scss-module__ZDJi6a__richText body3">
      <p>Das ist die <a href="https://www.br.de/eu">Europäische Perspektive</a> bei BR24.</p>
    </div></section>
    <section class="ArticleModuleText-module-scss-module__RqtLyq__wrapper"><div class="RichText-module-scss-module__ZDJi6a__richText body3">
      <p><em>"Hier ist Bayern": Der BR24 Newsletter informiert Sie.</em></p>
    </div></section>
  </section>
  <footer>
    <section><h2>Das könnte Sie auch interessieren</h2><article><h3>Kopfüber in Wiesn-Fahrgeschäft</h3></article></section>
    <section class="ArticleFooter-module-scss-module__rpHnHa__tagsSection"><h2>Schlagwörter</h2><ul><li><a href="/t">Oktoberfest</a></li></ul></section>
  </footer>
</article></main></body></html>`;

describe("extractTagesschauContent on a BR24 page", () => {
  const $ = cheerio.load(extractTagesschauContent(BR24_PAGE));
  const text = $.text();

  it("recognises the page", () => {
    expect(isBr24Page(cheerio.load(BR24_PAGE))).toBe(true);
  });

  it("extracts the teaser and the article body, links intact", () => {
    expect($("p").first().text()).toBe("Ein Mitarbeiter ist ums Leben gekommen.");
    expect(text).toContain("tödlich verunglückt.");
    expect($("a[href='https://www.br.de/wiesn']").text()).toBe("Mitarbeiter");
    expect(
      $("h2")
        .map((_, el) => $(el).text())
        .get(),
    ).toEqual(["Ermittlungen laufen"]);
    expect(
      $("li")
        .map((_, el) => $(el).text())
        .get(),
    ).toEqual(["Erster Punkt", "Zweiter Punkt"]);
    expect(text).toContain("Mit Informationen von dpa.");
  });

  it("leaves out the hero chrome, cross-links, media labels, promotions and footer", () => {
    for (const junk of [
      "Bild",
      "Eindrücke vom Unfallort",
      "Über dieses Thema berichtet",
      "Direkt zum aktuellen Artikel",
      "Zum Artikel",
      "Video:",
      "Schwerer Unfall",
      "Europäische Perspektive",
      "Newsletter",
      "Das könnte Sie auch interessieren",
      "Schlagwörter",
    ]) {
      expect(text).not.toContain(junk);
    }
  });
});

describe("extractTagesschauContent on a Tagesschau page", () => {
  it("still reads textabsatz paragraphs", () => {
    const html = `<html><body><article>
      <p class="textabsatz">Erster Absatz.</p>
      <h2 class="meldung__subhead">Zwischentitel</h2>
      <p class="textabsatz">Zweiter Absatz.</p>
    </article></body></html>`;
    expect(isBr24Page(cheerio.load(html))).toBe(false);
    const $ = cheerio.load(extractTagesschauContent(html));
    expect(
      $("p")
        .map((_, el) => $(el).text())
        .get(),
    ).toEqual(["Erster Absatz.", "Zweiter Absatz."]);
    expect($("h2").text()).toBe("Zwischentitel");
  });
});
