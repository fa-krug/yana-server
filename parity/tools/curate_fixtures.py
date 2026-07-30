"""
Curate raw pipeline exports into the DESIRED fixture set.

The files in ``exports/`` are what the current Python pipeline actually emits. They carry
artifacts the end format does not want: the header image duplicated into the body, the title
repeated as an ``h1``, bylines and breadcrumbs, sponsored boxes, related-article tails, and UI
chrome. This tool strips those and writes ``parity/fixtures/desired/<aggregator>.json``.

The result is a SPEC, not a snapshot: it describes what the TypeScript aggregators should
produce, so it deliberately differs from current Python output. Every removal is recorded in the
output's ``curation.removed`` list with the rule that fired, so nothing is silently deleted.

Rules are of two kinds:
  * general  -- pattern rules applied to every fixture (R1-R6 below)
  * explicit -- per-fixture block ranges that needed human judgement (DROP_RANGES)

Run:  uv run python parity/tools/curate_fixtures.py
"""

import json
import re
import sys
from pathlib import Path
from typing import Any

REPO = Path(__file__).resolve().parents[2]
EXPORTS = REPO / "exports"
OUT = REPO / "parity" / "fixtures" / "desired"

STORED_PREFIX = "yana-img://"

# R3 -- UI chrome / metadata masquerading as body paragraphs.
CHROME_PATTERNS = [
    re.compile(r"^\s*alert!\s*$", re.I),  # heise security badge
    re.compile(r"^\s*home\s*>", re.I),  # breadcrumb trail
    re.compile(r"^\s*today\s+by\s+\S+", re.I),  # TorrentFreak byline
    re.compile(r"^\s*\d+\s+(hours?|days?|weeks?)\s+ago\s+by\s+", re.I),
    # NOTE: no `Duration: … | Download Episode` pattern here, deliberately. That line looks like
    # player chrome but is a FEATURE: PodcastAggregator emits it under the `include_download_link`
    # option (core/aggregators/podcast/aggregator.py:138,177), which defaults to True. Removing it
    # would delete functionality the feed owner opted into.
    re.compile(r"^\s*tags:\s*[\w\-]+(\s*,\s*[\w\-]+)*\s*$", re.I),  # tag footer
    re.compile(r"^\s*(share|share this|follow us|subscribe)\b.*$", re.I),
]

# Human-judged removals, matched by CONTENT rather than by index. Index ranges were tried first and
# proved unsafe: re-collecting a feed changes which article is sampled, and a stale range then
# deletes whatever happens to sit at those positions. One did exactly that -- it silently removed two
# real body paragraphs from a merkur article about Crete. Content matching either fires on the thing
# it names or does nothing at all.
#
# SPONSORED: drop the matching block itself.
SPONSORED_PATTERNS = [
    re.compile(r"content-partnerschaft", re.I),  # merkur: paid wetter.net box
    re.compile(r"wetter\.net.*auf den punkt gebracht", re.I),  # its heading
]

# TAIL: drop the matching block and everything after it -- BUT only when the marker really is at the
# end. The Verge embeds a "Related" box MID-article and then continues the body; treating that as a
# tail deleted three genuine paragraphs (Apple pricing, the Upgrade program, $30.74bn services
# revenue). A marker earlier than this fraction is handled as an inline box instead: the heading and
# an immediately-following list go, the body after it stays.
TAIL_MIN_POSITION = 0.70

TAIL_PATTERNS = [
    re.compile(r"^\s*popular posts\s*$", re.I),
    re.compile(r"^\s*from \d+\s+years?\s+ago", re.I),
    re.compile(r"^\s*related( articles| reading)?\s*$", re.I),
    re.compile(r"^\s*(more|read) (from|on|about)\b.*$", re.I),
]

# R7 -- a trailing lone paragraph that is really the preceding image's caption.
CAPTION_MERGE = {"oglaf"}

# Image-first content: the comic IS the article. A one-image body is correct here, so the
# "under-extracted" and "header image in body" shape checks do not apply.
COMIC_AGGREGATORS = {"dark_legacy", "explosm", "oglaf"}


def runs_text(runs: Any) -> str:
    if not isinstance(runs, list):
        return ""
    if runs and isinstance(runs[0], dict) and "runs" in runs[0]:
        return " ".join(runs_text(r.get("runs")) for r in runs)
    return "".join(r.get("text", "") for r in runs if isinstance(r, dict))


def block_text(block: dict) -> str:
    return runs_text(block.get("runs"))


def normalized(value: str) -> str:
    return re.sub(r"[^\w]+", " ", value or "").strip().lower()


def is_title_dup(block: dict, title: str) -> bool:
    """R2 -- heading (or leading paragraph) repeating the article title."""
    text = normalized(block_text(block))
    ref = normalized(title)
    if not text or not ref:
        return False
    if text == ref:
        return True
    # feed_content prefixes its own kicker, e.g. "TIL: <title>".
    return len(text) < len(ref) + 12 and text.endswith(ref)


def curate(name: str, raw: dict) -> dict:
    blocks: list[dict] = list(raw["document"]["blocks"])
    title = raw["article"]["name"]
    has_icon = bool(raw["article"].get("icon"))
    removed: list[dict] = []
    keep: list[bool] = [True] * len(blocks)

    def drop(i: int, rule: str, why: str) -> None:
        if keep[i]:
            keep[i] = False
            removed.append(
                {
                    "index": i,
                    "rule": rule,
                    "reason": why,
                    "type": blocks[i].get("type"),
                    "excerpt": (block_text(blocks[i]) or str(blocks[i].get("ref", "")))[:90],
                }
            )

    # R1 -- header image duplicated into the body. The header belongs in Article.icon only.
    if blocks and blocks[0].get("type") == "image" and has_icon:
        drop(0, "R1", "leading image duplicates the article header image (lives in icon)")

    for i, block in enumerate(blocks):
        kind = block.get("type")

        # R2 -- title repeated inside the body.
        if kind in ("heading", "paragraph") and i <= 2 and is_title_dup(block, title):
            drop(i, "R2", "repeats the article title, which is carried by article.name")

        # R3 -- chrome paragraphs.
        if kind == "paragraph":
            text = block_text(block).strip()
            for pattern in CHROME_PATTERNS:
                if pattern.match(text):
                    drop(i, "R3", f"UI chrome / metadata, not body prose ({pattern.pattern})")
                    break

    # Sponsored blocks: drop just the matching block.
    for i, block in enumerate(blocks):
        text = block_text(block).strip()
        if not text:
            continue
        for pattern in SPONSORED_PATTERNS:
            if pattern.search(text):
                drop(i, "sponsored", f"paid/partner content ({pattern.pattern})")
                break

    # Related/promo markers. Near the end -> a real tail, drop to the end. Earlier -> an inline
    # related box, drop only the marker and an immediately-following list so body prose survives.
    marker = None
    for i, block in enumerate(blocks):
        text = block_text(block).strip()
        if text and any(p.match(text) for p in TAIL_PATTERNS):
            marker = i
            break
    if marker is not None:
        if blocks and marker / len(blocks) >= TAIL_MIN_POSITION:
            for i in range(marker, len(blocks)):
                drop(i, "tail", "related/promo tail, runs to the end of the extracted body")
        else:
            drop(marker, "inline-related", "inline related-links box, mid-article")
            if marker + 1 < len(blocks) and blocks[marker + 1].get("type") == "list":
                drop(marker + 1, "inline-related", "the inline related box's link list")

    kept = [b for i, b in enumerate(blocks) if keep[i]]

    # R7 -- fold a trailing caption paragraph into the image above it.
    if (
        name in CAPTION_MERGE
        and len(kept) == 2
        and kept[0].get("type") == "image"
        and kept[1].get("type") == "paragraph"
    ):
        caption_runs = kept[1].get("runs") or []
        if caption_runs and not kept[0].get("caption"):
            kept[0] = {**kept[0], "caption": caption_runs}
            removed.append(
                {
                    "index": 1,
                    "rule": "R7",
                    "reason": "trailing paragraph is the image's caption; folded into caption",
                    "type": "paragraph",
                    "excerpt": runs_text(caption_runs)[:90],
                }
            )
            kept = kept[:1]

    # R8 -- whitespace hygiene. Extraction leaves leading/trailing spaces on the outer runs;
    # the desired format carries none. Only the outer edges are touched, so inline structure
    # (bold/link boundaries) is preserved. A block left with no text at all is dropped.
    def tidy(block: dict) -> dict | None:
        if block.get("type") not in ("paragraph", "heading"):
            if block.get("type") == "blockquote":
                inner = [tidy(b) for b in block.get("blocks") or []]
                return {**block, "blocks": [b for b in inner if b]}
            if block.get("type") == "list":
                items = []
                for item in block.get("items") or []:
                    cleaned = [tidy(b) for b in item]
                    items.append([b for b in cleaned if b])
                return {**block, "items": [i for i in items if i]}
            return block
        runs = [dict(r) for r in block.get("runs") or []]
        if not runs:
            return None
        runs[0]["text"] = runs[0].get("text", "").lstrip()
        runs[-1]["text"] = runs[-1].get("text", "").rstrip()
        runs = [r for r in runs if r.get("text")]
        if not runs or not "".join(r.get("text", "") for r in runs).strip():
            return None
        return {**block, "runs": runs}

    tidied = [tidy(b) for b in kept]
    kept = [b for b in tidied if b]

    # R6 -- remote refs must be localized in the desired end state. Report, never rewrite:
    # inventing a hash would fake an image the corpus does not hold.
    remote: list[dict] = []

    def scan(items: list[dict]) -> None:
        for b in items:
            for field in ("ref", "thumbnailRef"):
                value = b.get(field)
                if isinstance(value, str) and value and not value.startswith(STORED_PREFIX):
                    remote.append({"type": b.get("type"), "field": field, "value": value})
            for inner in b.get("items") or []:
                scan(inner)
            scan(b.get("blocks") or [])

    scan(kept)

    # Gaps the curator must NOT silently fix -- they are aggregator defects the TypeScript port
    # has to get right, so they are surfaced as requirements instead of edited away.
    warnings: list[str] = []
    if remote:
        warnings.append(
            f"{len(remote)} image ref(s) still point at remote URLs; the desired format stores "
            f"every body image and references it as {STORED_PREFIX}<hash>"
        )
    # Comics are image-first by nature: a single image block IS the whole body, and that image is
    # content rather than a header. The two shape checks below would only ever misfire on them.
    if name not in COMIC_AGGREGATORS:
        if kept and kept[0].get("type") == "image" and not has_icon:
            warnings.append(
                "leading image is the article header but article.icon is empty; the header "
                "belongs in icon and must not also appear as the first body block"
            )
        if len(kept) < 3:
            warnings.append(
                f"only {len(kept)} block(s) -- body looks under-extracted (feed summary fallback "
                f"rather than the full article)"
            )

    document = {**raw["document"], "blocks": kept}
    return {
        "aggregator": raw["feed"]["aggregator"],
        "feed": raw["feed"],
        "article": {k: v for k, v in raw["article"].items() if k != "plainTextPreview"},
        "document": document,
        "images": raw["images"],
        "curation": {
            "rawBlockCount": len(blocks),
            "desiredBlockCount": len(kept),
            "removed": removed,
            "remoteRefsNeedingLocalization": remote,
            "warnings": warnings,
        },
    }


def main() -> int:
    if not EXPORTS.is_dir():
        print(f"no exports/ directory at {EXPORTS}", file=sys.stderr)
        return 1
    OUT.mkdir(parents=True, exist_ok=True)

    rows = []
    for path in sorted(EXPORTS.glob("*.json")):
        name = path.stem
        raw = json.loads(path.read_text())
        curated = curate(name, raw)
        (OUT / f"{name}.json").write_text(
            json.dumps(curated, indent=2, sort_keys=True, ensure_ascii=False) + "\n"
        )
        c = curated["curation"]
        rows.append(
            (
                name,
                c["rawBlockCount"],
                c["desiredBlockCount"],
                len(c["removed"]),
                len(c["remoteRefsNeedingLocalization"]),
                len(c["warnings"]),
            )
        )

    print(
        f"{'fixture':14s} {'raw':>5s} {'desired':>8s} {'removed':>8s} {'remote':>7s} {'warn':>5s}"
    )
    print("-" * 56)
    for name, raw_n, des_n, rem, remote, warn in rows:
        print(f"{name:14s} {raw_n:5d} {des_n:8d} {rem:8d} {remote:7d} {warn:5d}")
    print(f"\n{len(rows)} fixtures written -> {OUT}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
