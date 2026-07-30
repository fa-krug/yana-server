# Phase 0: Golden Corpus & Generator — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce a committed, language-neutral corpus of golden records that pins the current Python aggregator pipeline's output, so the TypeScript port in phases 11a–11c has a falsifiable parity oracle after Python is deleted.

**Architecture:** A `parity/` directory at the repository root holds three things: input fixtures (HTML, API JSON, and a local image map), a language-neutral case list, and generated golden records. A Python generator drives the *current* pipeline over each case with the network stubbed to serve fixtures, encodes the resulting block tree through the existing `core/blocks/schema.py` wire encoder, normalizes image references to stable keys, and writes one JSON record per case. Phases 11a–11c reimplement only the *comparison* side in TypeScript.

**Tech Stack:** Python 3.13, pytest, the existing `core.blocks.schema` encoder. No new runtime dependencies.

## Global Constraints

- `parity/` lives at the **repository root** and must survive phase 14's folder swap unchanged.
- Golden records are **generated artifacts that are committed**. They are never hand-edited. Changing one requires re-running the generator and saying why in the commit message.
- The generator must be **deterministic**: two consecutive runs over an unchanged corpus produce byte-identical records. Anything time-, locale-, or ordering-dependent is a defect to fix, not to tolerate.
- **No network access during generation.** Every fetch — HTML, API JSON, and images — resolves from `parity/fixtures/`. A generation run that touches the network is a defect.
- Image `contentHash` is **never** written into a golden record. See the parity contract in `docs/superpowers/specs/2026-07-30-nextjs-migration-direction.md`.
- Wire format is version **1**, exactly as `core/blocks/types.py::FORMAT_VERSION` defines it. Golden records embed that version and a `parityVersion` of their own.
- Fixture staleness relative to live sites is **explicitly acceptable** and must not be "fixed".
- Line length 100, double quotes, `ruff format`, type hints checked by `mypy` — the repository's existing standards apply to everything under `parity/`.

---

## File Structure

| Path | Responsibility |
|---|---|
| `parity/README.md` | What the corpus is, how to regenerate, why hashes are excluded |
| `parity/cases.json` | Language-neutral case list — the single source of truth both languages read |
| `parity/fixtures/html/*.html` | Page fixtures |
| `parity/fixtures/api/*.json` | Reddit / YouTube API response fixtures |
| `parity/fixtures/images/*` | Source image bytes |
| `parity/fixtures/images/manifest.json` | Maps remote image URL → local fixture filename |
| `parity/records/<case-id>.golden.json` | One generated golden record per case |
| `parity/generate.py` | The generator entry point (Django management-style script) |
| `parity/harness.py` | Network stubbing + provenance capture, shared by generator and tests |
| `parity/normalize.py` | Image-ref normalization; the Python half of a two-language contract |
| `core/tests/test_parity_corpus.py` | Guards determinism, schema validity, and no-network |

---

### Task 1: Recover the archived fixture corpus

The pre-Django TypeScript tree carried nine fixtures that were deleted in `8fde9be`. They are recoverable and directly reusable — a parity golden only requires both implementations to receive identical bytes, so drift from the live site is irrelevant.

**Files:**
- Create: `parity/fixtures/html/{heise,tagesschau,mein_mmo,merkur,podcast,oglaf,full_website,feed_content}.html`
- Create: `parity/fixtures/api/{reddit-api,youtube-api}.json`
- Create: `parity/README.md`

**Interfaces:**
- Consumes: nothing.
- Produces: fixture files at the paths above, referenced by `parity/cases.json` in Task 3.

- [ ] **Step 1: Confirm the archived paths still resolve**

```bash
git show 8fde9be --name-only --diff-filter=D | grep "__tests__/fixtures/"
```

Expected: eleven paths under `old/src/server/aggregators/__tests__/fixtures/`, including `README.md`.

- [ ] **Step 2: Extract the nine reusable fixtures**

```bash
mkdir -p parity/fixtures/html parity/fixtures/api

for name in heise tagesschau mein_mmo merkur podcast oglaf full_website feed_content; do
  git show "8fde9be^:old/src/server/aggregators/__tests__/fixtures/$name.html" \
    > "parity/fixtures/html/$name.html"
done

for name in reddit-api youtube-api; do
  git show "8fde9be^:old/src/server/aggregators/__tests__/fixtures/$name.json" \
    > "parity/fixtures/api/$name.json"
done
```

- [ ] **Step 3: Verify sizes match the archive**

```bash
ls -l parity/fixtures/html parity/fixtures/api
```

Expected, to the byte: `feed_content.html` 3266459, `full_website.html` 3211723, `heise.html` 3211528, `mein_mmo.html` 405065, `merkur.html` 255409, `tagesschau.html` 431692, `podcast.html` 136554, `oglaf.html` 3760, `reddit-api.json` 1145, `youtube-api.json` 1076.

A mismatch means the extraction picked up a different revision — stop and re-check the ref before continuing.

- [ ] **Step 4: Copy the five current fixtures across**

```bash
cp core/tests/fixtures/caschys_blog.html \
   core/tests/fixtures/dark_legacy.html \
   core/tests/fixtures/explosm.html \
   core/tests/fixtures/mactechnews.html \
   core/tests/fixtures/mactechnews_multipage.html \
   parity/fixtures/html/
```

Copy, not move: `core/tests/` keeps using them until phase 14 removes Python.

- [ ] **Step 5: Write `parity/README.md`**

````markdown
# Parity corpus

Golden records pinning the Python aggregator pipeline's output, so the TypeScript
port can be checked against it after Python is gone.

## Why the fixtures look stale

They are stale, deliberately. A parity golden only needs both implementations to
receive **identical bytes** — whether that HTML still matches the live site is a
different question, answered by different tests. Do not refresh these to match
production. Nine of them were recovered from `8fde9be^`, predating the Django
rewrite, and that is fine.

## Why image hashes are absent

`ArticleImage.content_hash` is SHA-256 over the *compressed* bytes. Python
compresses with Pillow, TypeScript with sharp/libvips, and different encoders
emit different bytes for identical input. Hashes therefore cannot match and are
not compared. Records instead carry normalized refs (`yana-img://{img:N}`) plus
an image manifest asserting content type and dimensions exactly, and byte size
within a tolerance band.

See `docs/superpowers/specs/2026-07-30-nextjs-migration-direction.md`.

## Regenerating

```bash
uv run python parity/generate.py            # all cases
uv run python parity/generate.py --case heise/basic
```

Records are committed. Never hand-edit one — regenerate and explain the diff in
the commit message.
````

- [ ] **Step 6: Commit**

```bash
git add parity/
git commit -m "test(parity): Recover the archived fixture corpus

Nine fixtures deleted in 8fde9be are reusable as parity inputs: a golden only
requires both implementations to receive identical bytes, so drift from the live
site does not matter. Copies the five current fixtures alongside them; core/tests
keeps its own until Python is removed."
```

---

### Task 2: Build the image fixture map

Current aggregator tests patch `extract_header_element` away entirely, so image processing never runs under test. Parity needs the opposite: images *must* flow through compression, because that is where the block tree gets its `ref` values. Both implementations must compress the same source bytes, which means images resolve from a local map rather than the network.

**Files:**
- Create: `parity/fixtures/images/manifest.json`
- Create: `parity/fixtures/images/*` (image bytes)
- Create: `parity/tools/collect_images.py`

**Interfaces:**
- Consumes: fixture HTML from Task 1.
- Produces: `parity/fixtures/images/manifest.json`, a JSON object mapping absolute image URL → filename relative to `parity/fixtures/images/`. Task 4's harness reads it.

- [ ] **Step 1: Write the failing test**

```python
# core/tests/test_parity_corpus.py
import json
from pathlib import Path

PARITY = Path(__file__).resolve().parents[2] / "parity"


def test_image_manifest_entries_all_resolve():
    manifest = json.loads((PARITY / "fixtures/images/manifest.json").read_text())
    assert manifest, "image manifest is empty"
    for url, filename in manifest.items():
        assert url.startswith(("http://", "https://")), f"not an absolute URL: {url}"
        path = PARITY / "fixtures/images" / filename
        assert path.is_file(), f"{url} -> {filename} does not exist"
        assert path.stat().st_size > 0, f"{filename} is empty"
```

- [ ] **Step 2: Run it to confirm it fails**

```bash
uv run pytest core/tests/test_parity_corpus.py::test_image_manifest_entries_all_resolve -v
```

Expected: FAIL — `FileNotFoundError` on `manifest.json`.

- [ ] **Step 3: Write the collector**

```python
# parity/tools/collect_images.py
"""
One-shot: harvest every image URL referenced by the fixture HTML and download it
into the local image map.

Run once when adding fixtures. Its output is committed; the generator itself
never touches the network.
"""

import hashlib
import json
import sys
from pathlib import Path
from urllib.parse import urljoin

import requests
from bs4 import BeautifulSoup

PARITY = Path(__file__).resolve().parents[1]
IMAGES = PARITY / "fixtures/images"
MANIFEST = IMAGES / "manifest.json"

# Fixture -> the page URL it was captured from, for resolving relative srcs.
BASES = {
    "heise.html": "https://www.heise.de/",
    "tagesschau.html": "https://www.tagesschau.de/",
    "mein_mmo.html": "https://mein-mmo.de/",
    "merkur.html": "https://www.merkur.de/",
    "podcast.html": "https://example.com/",
    "oglaf.html": "https://www.oglaf.com/",
    "full_website.html": "https://example.com/",
    "feed_content.html": "https://example.com/",
    "caschys_blog.html": "https://stadt-bremerhaven.de/",
    "dark_legacy.html": "https://www.darklegacycomics.com/",
    "explosm.html": "https://explosm.net/",
    "mactechnews.html": "https://www.mactechnews.de/",
    "mactechnews_multipage.html": "https://www.mactechnews.de/",
}

EXTENSIONS = {
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/gif": "gif",
    "image/webp": "webp",
    "image/svg+xml": "svg",
}


def discover_urls() -> set[str]:
    urls: set[str] = set()
    for path in sorted((PARITY / "fixtures/html").glob("*.html")):
        base = BASES.get(path.name)
        if base is None:
            print(f"skip (no base URL registered): {path.name}", file=sys.stderr)
            continue
        soup = BeautifulSoup(path.read_text(errors="replace"), "html.parser")
        for tag in soup.find_all(["img", "source"]):
            for attr in ("src", "data-src", "srcset", "data-srcset"):
                raw = tag.get(attr)
                if not raw:
                    continue
                # srcset is "url w, url w"; take each candidate's URL half.
                for candidate in raw.split(","):
                    part = candidate.strip().split()
                    if part:
                        urls.add(urljoin(base, part[0]))
    return urls


def main() -> int:
    IMAGES.mkdir(parents=True, exist_ok=True)
    manifest: dict[str, str] = {}
    if MANIFEST.is_file():
        manifest = json.loads(MANIFEST.read_text())

    for url in sorted(discover_urls()):
        if url in manifest:
            continue
        if url.startswith("data:"):
            continue
        try:
            response = requests.get(url, timeout=30)
            response.raise_for_status()
        except Exception as error:  # noqa: BLE001 - a best-effort harvest
            print(f"skip {url}: {error}", file=sys.stderr)
            continue

        content_type = response.headers.get("Content-Type", "").split(";")[0].strip()
        extension = EXTENSIONS.get(content_type)
        if extension is None:
            print(f"skip {url}: unsupported type {content_type!r}", file=sys.stderr)
            continue

        digest = hashlib.sha256(response.content).hexdigest()[:16]
        filename = f"{digest}.{extension}"
        (IMAGES / filename).write_bytes(response.content)
        manifest[url] = filename
        print(f"saved {url} -> {filename}")

    MANIFEST.write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n")
    print(f"{len(manifest)} entries")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
```

- [ ] **Step 4: Run the collector**

```bash
uv run python parity/tools/collect_images.py
```

Expected: image files written and a populated `manifest.json`. Many URLs will fail — these fixtures are years old and their CDN paths are dead. **That is fine and expected.** Only entries that actually downloaded end up in the manifest; cases whose images are unavailable still produce valid goldens, they just carry remote-URL refs instead of `yana-img://` refs.

- [ ] **Step 5: Run the test to verify it passes**

```bash
uv run pytest core/tests/test_parity_corpus.py::test_image_manifest_entries_all_resolve -v
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add parity/fixtures/images parity/tools core/tests/test_parity_corpus.py
git commit -m "test(parity): Add a local image map for the fixture corpus

Both implementations must compress identical source bytes for image assertions
to mean anything, so images resolve from a committed local map rather than the
network. Dead CDN paths in the older fixtures are expected and skipped; those
cases keep remote-URL refs."
```

---

### Task 3: Define the case list

A case is one (aggregator, fixture, options) triple. The list is JSON rather than Python so that phases 11a–11c read the *same* file instead of a translated copy that can drift.

**Files:**
- Create: `parity/cases.json`
- Modify: `core/tests/test_parity_corpus.py`

**Interfaces:**
- Consumes: fixture paths from Tasks 1–2.
- Produces: `parity/cases.json` — a JSON object `{"parityVersion": 1, "cases": [Case, ...]}` where each `Case` is:

```
{
  "id":         string   // "<aggregator>/<variant>", also the record filename stem
  "aggregator": string   // a key in core/choices.py AGGREGATOR_CHOICES
  "sourceUrl":  string   // the URL the fixture stands in for; resolves relative links
  "fixture":    string   // path relative to parity/fixtures/
  "options":    object   // Feed.options for this case
  "identifier": string   // Feed.identifier
}
```

- [ ] **Step 1: Write the failing test**

```python
# core/tests/test_parity_corpus.py  (append)
from core.aggregators.registry import AggregatorRegistry

CASES = json.loads((PARITY / "cases.json").read_text())


def test_case_list_is_well_formed():
    assert CASES["parityVersion"] == 1
    seen = set()
    for case in CASES["cases"]:
        assert set(case) == {
            "id",
            "aggregator",
            "sourceUrl",
            "fixture",
            "options",
            "identifier",
        }, f"unexpected keys in {case.get('id')!r}"
        assert case["id"] not in seen, f"duplicate case id: {case['id']}"
        seen.add(case["id"])
        assert AggregatorRegistry.get(case["aggregator"]) is not None
        assert (PARITY / "fixtures" / case["fixture"]).is_file(), case["fixture"]


def test_every_aggregator_has_at_least_one_case():
    from core.choices import AGGREGATOR_CHOICES

    covered = {case["aggregator"] for case in CASES["cases"]}
    missing = {key for key, _ in AGGREGATOR_CHOICES} - covered
    assert not missing, f"aggregators with no parity case: {sorted(missing)}"
```

- [ ] **Step 2: Run it to confirm it fails**

```bash
uv run pytest core/tests/test_parity_corpus.py -v -k case
```

Expected: FAIL — `cases.json` missing.

- [ ] **Step 3: Enumerate the aggregator keys**

```bash
uv run python -c "from core.choices import AGGREGATOR_CHOICES; print([k for k,_ in AGGREGATOR_CHOICES])"
```

Write the output down. Every key needs a case, and `test_every_aggregator_has_at_least_one_case` is what enforces it.

- [ ] **Step 4: Write `parity/cases.json`**

Start from the fixtures on hand. `full_website`, `rss`, `podcast`, `reddit` and `youtube` map onto the generic fixtures; the scraper aggregators map onto their own.

```json
{
  "parityVersion": 1,
  "cases": [
    {
      "id": "heise/basic",
      "aggregator": "heise",
      "sourceUrl": "https://www.heise.de/news/fixture",
      "fixture": "html/heise.html",
      "options": {},
      "identifier": "https://www.heise.de/rss/news.rdf"
    },
    {
      "id": "tagesschau/basic",
      "aggregator": "tagesschau",
      "sourceUrl": "https://www.tagesschau.de/inland/fixture.html",
      "fixture": "html/tagesschau.html",
      "options": {},
      "identifier": "https://www.tagesschau.de/xml/rss2"
    },
    {
      "id": "mein_mmo/basic",
      "aggregator": "mein_mmo",
      "sourceUrl": "https://mein-mmo.de/fixture/",
      "fixture": "html/mein_mmo.html",
      "options": {},
      "identifier": "https://mein-mmo.de/feed/"
    },
    {
      "id": "mein_mmo/combined-pages",
      "aggregator": "mein_mmo",
      "sourceUrl": "https://mein-mmo.de/fixture/",
      "fixture": "html/mein_mmo.html",
      "options": { "combine_pages": true },
      "identifier": "https://mein-mmo.de/feed/"
    },
    {
      "id": "merkur/basic",
      "aggregator": "merkur",
      "sourceUrl": "https://www.merkur.de/fixture.html",
      "fixture": "html/merkur.html",
      "options": {},
      "identifier": "https://www.merkur.de/rssfeed.rdf"
    },
    {
      "id": "mactechnews/basic",
      "aggregator": "mactechnews",
      "sourceUrl": "https://www.mactechnews.de/news/article/fixture.html",
      "fixture": "html/mactechnews.html",
      "options": {},
      "identifier": "https://www.mactechnews.de/news/rss.xml"
    },
    {
      "id": "mactechnews/multipage",
      "aggregator": "mactechnews",
      "sourceUrl": "https://www.mactechnews.de/news/article/fixture.html",
      "fixture": "html/mactechnews_multipage.html",
      "options": { "combine_pages": true },
      "identifier": "https://www.mactechnews.de/news/rss.xml"
    },
    {
      "id": "caschys_blog/basic",
      "aggregator": "caschys_blog",
      "sourceUrl": "https://stadt-bremerhaven.de/fixture/",
      "fixture": "html/caschys_blog.html",
      "options": {},
      "identifier": "https://stadt-bremerhaven.de/feed/"
    },
    {
      "id": "dark_legacy/basic",
      "aggregator": "dark_legacy",
      "sourceUrl": "https://www.darklegacycomics.com/fixture",
      "fixture": "html/dark_legacy.html",
      "options": {},
      "identifier": "https://www.darklegacycomics.com/feed.xml"
    },
    {
      "id": "explosm/basic",
      "aggregator": "explosm",
      "sourceUrl": "https://explosm.net/comics/fixture",
      "fixture": "html/explosm.html",
      "options": {},
      "identifier": "https://explosm.net/rss.xml"
    },
    {
      "id": "oglaf/basic",
      "aggregator": "oglaf",
      "sourceUrl": "https://www.oglaf.com/fixture/",
      "fixture": "html/oglaf.html",
      "options": {},
      "identifier": "https://www.oglaf.com/feeds/rss/"
    },
    {
      "id": "podcast/basic",
      "aggregator": "podcast",
      "sourceUrl": "https://example.com/podcast/fixture",
      "fixture": "html/podcast.html",
      "options": { "include_download_link": true },
      "identifier": "https://example.com/podcast/feed.xml"
    },
    {
      "id": "full_website/basic",
      "aggregator": "full_website",
      "sourceUrl": "https://example.com/fixture",
      "fixture": "html/full_website.html",
      "options": {},
      "identifier": "https://example.com/feed.xml"
    },
    {
      "id": "rss/basic",
      "aggregator": "rss",
      "sourceUrl": "https://example.com/fixture",
      "fixture": "html/feed_content.html",
      "options": {},
      "identifier": "https://example.com/feed.xml"
    },
    {
      "id": "reddit/basic",
      "aggregator": "reddit",
      "sourceUrl": "https://oauth.reddit.com/r/fixture/new",
      "fixture": "api/reddit-api.json",
      "options": { "include_comments": true, "max_comments": 5 },
      "identifier": "fixture"
    },
    {
      "id": "youtube/basic",
      "aggregator": "youtube",
      "sourceUrl": "https://www.googleapis.com/youtube/v3/fixture",
      "fixture": "api/youtube-api.json",
      "options": { "include_player": true },
      "identifier": "UCfixturechannelid00000"
    }
  ]
}
```

- [ ] **Step 5: Run the tests**

```bash
uv run pytest core/tests/test_parity_corpus.py -v -k "case or aggregator"
```

Expected: `test_case_list_is_well_formed` PASSES. `test_every_aggregator_has_at_least_one_case` **FAILS**, naming the aggregators with no case — `ars_technica` and `the_verge` at minimum.

- [ ] **Step 6: Capture the missing fixtures**

For each aggregator the test named, save a real article page into `parity/fixtures/html/` and add a case. `ars_technica` and `the_verge` are expected; treat anything else the test names as a genuine gap.

```bash
curl -sL "https://arstechnica.com/<a-current-article>/" -o parity/fixtures/html/ars_technica.html
curl -sL "https://www.theverge.com/<a-current-article>" -o parity/fixtures/html/the_verge.html
uv run python parity/tools/collect_images.py
```

Then add the corresponding entries to `cases.json`, following the shape above.

- [ ] **Step 7: Run the tests to verify both pass**

```bash
uv run pytest core/tests/test_parity_corpus.py -v
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add parity/cases.json parity/fixtures core/tests/test_parity_corpus.py
git commit -m "test(parity): Define the parity case list

cases.json is JSON rather than Python so phases 11a-11c read the same file
instead of a translated copy that can drift. A test asserts every aggregator in
AGGREGATOR_CHOICES has at least one case, which is what surfaced the missing
ars_technica and the_verge fixtures."
```

---

### Task 4: Build the offline harness

**Files:**
- Create: `parity/harness.py`
- Test: `core/tests/test_parity_harness.py`

**Interfaces:**
- Consumes: `parity/cases.json`, `parity/fixtures/images/manifest.json`.
- Produces:
  - `class ImageProvenance` with `record(url: str, content_hash: str) -> None` and `hash_to_url: dict[str, str]`.
  - `offline(case: dict, provenance: ImageProvenance) -> contextlib.AbstractContextManager[None]` — a context manager that, while active, makes every HTML fetch return the case's fixture, every image fetch resolve from the local map, and any unmapped network call raise `NetworkAccessDenied`.
  - `class NetworkAccessDenied(RuntimeError)`.

- [ ] **Step 1: Write the failing test**

```python
# core/tests/test_parity_harness.py
import json
from pathlib import Path

import pytest

from parity.harness import ImageProvenance, NetworkAccessDenied, offline

PARITY = Path(__file__).resolve().parents[2] / "parity"
CASE = {
    "id": "probe/basic",
    "aggregator": "full_website",
    "sourceUrl": "https://example.com/fixture",
    "fixture": "html/full_website.html",
    "options": {},
    "identifier": "https://example.com/feed.xml",
}


def test_html_fetch_returns_the_fixture():
    from core.aggregators.utils.html_fetcher import fetch_html

    with offline(CASE, ImageProvenance()):
        html = fetch_html("https://example.com/anything")

    expected = (PARITY / "fixtures/html/full_website.html").read_text(errors="replace")
    assert html == expected


def test_unmapped_image_fetch_is_denied():
    from core.aggregators.services.image_extraction.fetcher import fetch_single_image

    with offline(CASE, ImageProvenance()), pytest.raises(NetworkAccessDenied):
        fetch_single_image("https://nowhere.invalid/never-mapped.jpg")


def test_mapped_image_fetch_returns_local_bytes():
    from core.aggregators.services.image_extraction.fetcher import fetch_single_image

    manifest = json.loads((PARITY / "fixtures/images/manifest.json").read_text())
    url, filename = next(iter(sorted(manifest.items())))
    expected = (PARITY / "fixtures/images" / filename).read_bytes()

    with offline(CASE, ImageProvenance()):
        result = fetch_single_image(url)

    assert result is not None
    assert expected in (result if isinstance(result, bytes) else result[0])


def test_provenance_records_url_for_hash():
    provenance = ImageProvenance()
    provenance.record("https://example.com/a.jpg", "abc123")
    assert provenance.hash_to_url == {"abc123": "https://example.com/a.jpg"}
```

- [ ] **Step 2: Run it to confirm it fails**

```bash
uv run pytest core/tests/test_parity_harness.py -v
```

Expected: FAIL — `ModuleNotFoundError: No module named 'parity.harness'`.

- [ ] **Step 3: Inspect the real signatures before stubbing them**

The patch targets must match what the pipeline actually imports, and `fetch_single_image`'s return shape must be reproduced exactly.

```bash
grep -rn "def fetch_html\|def fetch_binary" core/aggregators/utils/html_fetcher.py
grep -rn "def fetch_single_image" -A 25 core/aggregators/services/image_extraction/fetcher.py
grep -rn "from .*html_fetcher import\|from .*fetcher import" core --include='*.py' | grep -v __pycache__
```

Record the return type of `fetch_single_image` and every module that imports these by name. Patching the *definition* module is not enough when callers did `from … import fetch_html` — each such module needs its own patch, which is why the harness patches a list of targets rather than one.

- [ ] **Step 4: Write the harness**

```python
# parity/harness.py
"""
Offline execution context for parity generation.

Every fetch resolves from ``parity/fixtures/``. An unmapped fetch raises rather
than reaching the network, because a golden generated against live data is not
reproducible and would silently rot.
"""

import contextlib
import json
from collections.abc import Iterator
from pathlib import Path
from unittest.mock import patch

PARITY = Path(__file__).resolve().parent
IMAGES = PARITY / "fixtures/images"


class NetworkAccessDenied(RuntimeError):
    """A fetch was attempted for something the fixture corpus does not cover."""


class ImageProvenance:
    """
    Remembers which source URL produced which stored image hash.

    ``ArticleImage`` does not persist a source URL, but golden records need one
    to key normalized refs by. Capturing it at fetch time is the only place the
    association exists.
    """

    def __init__(self) -> None:
        self.hash_to_url: dict[str, str] = {}

    def record(self, url: str, content_hash: str) -> None:
        self.hash_to_url.setdefault(content_hash, url)


def _image_map() -> dict[str, str]:
    path = IMAGES / "manifest.json"
    return json.loads(path.read_text()) if path.is_file() else {}


# Modules that bound these names at import time and therefore need their own patch.
# Derived in Step 3 -- extend it when a new call site appears.
_HTML_TARGETS = (
    "core.aggregators.utils.html_fetcher.fetch_html",
    "core.aggregators.website.fetch_html",
)
_IMAGE_TARGETS = ("core.aggregators.services.image_extraction.fetcher.fetch_single_image",)


@contextlib.contextmanager
def offline(case: dict, provenance: ImageProvenance) -> Iterator[None]:
    """Serve every fetch from the fixture corpus for the duration of the block."""
    fixture = (PARITY / "fixtures" / case["fixture"]).read_text(errors="replace")
    images = _image_map()

    def fake_fetch_html(url: str, *args: object, **kwargs: object) -> str:
        return fixture

    def fake_fetch_image(url: str, *args: object, **kwargs: object):
        filename = images.get(url)
        if filename is None:
            raise NetworkAccessDenied(f"no image fixture for {url}")
        data = (IMAGES / filename).read_bytes()
        provenance.record(url, "")  # replaced by the real hash in Step 5's wrapper
        return data

    with contextlib.ExitStack() as stack:
        for target in _HTML_TARGETS:
            stack.enter_context(patch(target, side_effect=fake_fetch_html))
        for target in _IMAGE_TARGETS:
            stack.enter_context(patch(target, side_effect=fake_fetch_image))
        yield
```

- [ ] **Step 5: Correct the provenance wiring**

The stub above records an empty hash, because the hash is only known after compression, downstream of the fetch. Wrap the image store instead so provenance is recorded where both facts exist together.

First find the store's entry point:

```bash
grep -n "def \|content_hash" core/aggregators/services/image_store.py | head -30
```

Then add to `parity/harness.py`, and enter it in `offline`'s `ExitStack` alongside the other patches:

```python
def _wrap_store(provenance: ImageProvenance, url_of: dict[int, str]):
    """
    Patch the image store so each stored hash is associated with the URL its
    bytes came from. ``url_of`` maps ``id(bytes)`` to source URL, populated by
    the fetch stub -- the only handle available, since the store receives bytes
    with no URL attached.
    """
    from core.aggregators.services import image_store

    original = image_store.store_image  # confirm this name in the grep above

    def wrapper(data: bytes, *args: object, **kwargs: object):
        result = original(data, *args, **kwargs)
        url = url_of.get(id(data))
        content_hash = getattr(result, "content_hash", None)
        if url and content_hash:
            provenance.record(url, content_hash)
        return result

    return patch.object(image_store, "store_image", side_effect=wrapper)
```

and change the fetch stub to populate `url_of`:

```python
    url_of: dict[int, str] = {}

    def fake_fetch_image(url: str, *args: object, **kwargs: object):
        filename = images.get(url)
        if filename is None:
            raise NetworkAccessDenied(f"no image fixture for {url}")
        data = (IMAGES / filename).read_bytes()
        url_of[id(data)] = url
        return data
```

- [ ] **Step 6: Run the tests to verify they pass**

```bash
uv run pytest core/tests/test_parity_harness.py -v
```

Expected: PASS. If `test_mapped_image_fetch_returns_local_bytes` fails on shape, adjust the stub's return to match the real `fetch_single_image` signature recorded in Step 3 — the stub must be shape-identical, not merely close.

- [ ] **Step 7: Commit**

```bash
git add parity/harness.py core/tests/test_parity_harness.py
git commit -m "test(parity): Add the offline generation harness

Unmapped fetches raise instead of reaching the network: a golden generated
against live data is not reproducible and would rot silently. Provenance is
captured by wrapping the image store rather than the fetcher, because the source
URL and the content hash only coexist at that seam -- ArticleImage does not
persist a source URL."
```

---

### Task 5: Implement ref normalization

**Files:**
- Create: `parity/normalize.py`
- Test: `core/tests/test_parity_normalize.py`

**Interfaces:**
- Consumes: the wire encoding from `core/blocks/schema.py::encode_document`.
- Produces: `normalize_document(document: dict, hash_to_url: dict[str, str]) -> tuple[dict, list[dict]]` — returns the document with `yana-img://<hash>` rewritten to `yana-img://{img:N}`, plus an image manifest list ordered by key. Phases 11a–11c reimplement this exact algorithm in TypeScript, so the rules below are a contract.

The algorithm, stated precisely because two languages must agree on it:

1. Walk blocks depth-first, pre-order. Children are visited in wire order: `list.items` outer-then-inner, `blockquote.blocks` in order.
2. Within a block, inspect `ref` (type `image`) then `thumbnailRef` (type `embed`).
3. A value is a candidate only if it starts with `yana-img://`. Anything else — a remote URL, an empty value, `null` — is left untouched.
4. Assign keys in first-encounter order, starting at `img:0`. The same hash always maps to the same key.
5. Replace the value with `yana-img://{<key>}`.

- [ ] **Step 1: Write the failing test**

```python
# core/tests/test_parity_normalize.py
from parity.normalize import normalize_document


def test_assigns_keys_in_first_encounter_order():
    document = {
        "version": 1,
        "blocks": [
            {"type": "image", "ref": "yana-img://bbb", "caption": []},
            {"type": "image", "ref": "yana-img://aaa", "caption": []},
        ],
    }
    normalized, manifest = normalize_document(document, {"aaa": "https://x/a", "bbb": "https://x/b"})

    assert normalized["blocks"][0]["ref"] == "yana-img://{img:0}"
    assert normalized["blocks"][1]["ref"] == "yana-img://{img:1}"
    assert [entry["key"] for entry in manifest] == ["img:0", "img:1"]
    assert manifest[0]["sourceUrl"] == "https://x/b"


def test_repeated_hash_reuses_its_key():
    document = {
        "version": 1,
        "blocks": [
            {"type": "image", "ref": "yana-img://aaa", "caption": []},
            {"type": "image", "ref": "yana-img://aaa", "caption": []},
        ],
    }
    normalized, manifest = normalize_document(document, {"aaa": "https://x/a"})

    assert normalized["blocks"][0]["ref"] == "yana-img://{img:0}"
    assert normalized["blocks"][1]["ref"] == "yana-img://{img:0}"
    assert len(manifest) == 1


def test_remote_and_empty_refs_are_untouched():
    document = {
        "version": 1,
        "blocks": [
            {"type": "image", "ref": "https://cdn.example/a.jpg", "caption": []},
            {"type": "embed", "provider": "youtube", "thumbnailRef": None,
             "externalURL": "https://youtu.be/x", "title": None},
        ],
    }
    normalized, manifest = normalize_document(document, {})

    assert normalized["blocks"][0]["ref"] == "https://cdn.example/a.jpg"
    assert normalized["blocks"][1]["thumbnailRef"] is None
    assert manifest == []


def test_walks_nested_lists_and_blockquotes_in_wire_order():
    document = {
        "version": 1,
        "blocks": [
            {"type": "list", "ordered": False, "items": [
                [{"type": "image", "ref": "yana-img://first", "caption": []}],
                [{"type": "blockquote", "blocks": [
                    {"type": "image", "ref": "yana-img://second", "caption": []}
                ]}],
            ]},
        ],
    }
    _, manifest = normalize_document(document, {"first": "https://x/1", "second": "https://x/2"})

    assert [entry["sourceUrl"] for entry in manifest] == ["https://x/1", "https://x/2"]


def test_embed_thumbnail_is_normalized():
    document = {
        "version": 1,
        "blocks": [
            {"type": "embed", "provider": "youtube", "thumbnailRef": "yana-img://thumb",
             "externalURL": "https://youtu.be/x", "title": None},
        ],
    }
    normalized, manifest = normalize_document(document, {"thumb": "https://i.ytimg/x.jpg"})

    assert normalized["blocks"][0]["thumbnailRef"] == "yana-img://{img:0}"
    assert manifest[0]["key"] == "img:0"
```

- [ ] **Step 2: Run it to confirm it fails**

```bash
uv run pytest core/tests/test_parity_normalize.py -v
```

Expected: FAIL — `ModuleNotFoundError: No module named 'parity.normalize'`.

- [ ] **Step 3: Write the implementation**

```python
# parity/normalize.py
"""
Image-ref normalization for golden records.

Content hashes cannot agree across Pillow and sharp -- different encoders emit
different bytes, so the SHA-256 over those bytes differs. Refs are therefore
rewritten to stable, source-URL-keyed placeholders before comparison.

This algorithm is a two-language contract. Phases 11a-11c reimplement it in
TypeScript; the walk order and key assignment must match exactly.
"""

import copy
from typing import Any

PREFIX = "yana-img://"


def _is_stored_ref(value: Any) -> bool:
    return isinstance(value, str) and value.startswith(PREFIX)


def _hash_of(value: str) -> str:
    return value[len(PREFIX) :]


def normalize_document(
    document: dict[str, Any], hash_to_url: dict[str, str]
) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    """Rewrite stored refs to ``yana-img://{img:N}`` and return the image manifest."""
    result = copy.deepcopy(document)
    keys: dict[str, str] = {}

    def key_for(content_hash: str) -> str:
        if content_hash not in keys:
            keys[content_hash] = f"img:{len(keys)}"
        return keys[content_hash]

    def visit(block: dict[str, Any]) -> None:
        kind = block.get("type")

        if kind == "image" and _is_stored_ref(block.get("ref")):
            block["ref"] = f"{PREFIX}{{{key_for(_hash_of(block['ref']))}}}"
        elif kind == "embed" and _is_stored_ref(block.get("thumbnailRef")):
            block["thumbnailRef"] = f"{PREFIX}{{{key_for(_hash_of(block['thumbnailRef']))}}}"

        # Recurse in wire order.
        if kind == "list":
            for item in block.get("items") or []:
                for inner in item:
                    visit(inner)
        elif kind == "blockquote":
            for inner in block.get("blocks") or []:
                visit(inner)

    for block in result.get("blocks") or []:
        visit(block)

    manifest = [
        {"key": key, "sourceUrl": hash_to_url.get(content_hash, "")}
        for content_hash, key in keys.items()
    ]
    return result, manifest
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
uv run pytest core/tests/test_parity_normalize.py -v
```

Expected: PASS, all five.

- [ ] **Step 5: Commit**

```bash
git add parity/normalize.py core/tests/test_parity_normalize.py
git commit -m "feat(parity): Normalize image refs for golden comparison

Hashes are SHA-256 over compressed bytes, and Pillow and sharp/libvips do not
agree on those bytes, so refs are rewritten to source-URL-keyed placeholders
instead. The walk order and key assignment are a two-language contract -- the
TypeScript port in 11a must reimplement them exactly."
```

---

### Task 6: Write the generator and produce the records

**Files:**
- Create: `parity/generate.py`
- Modify: `core/tests/test_parity_corpus.py`
- Create: `parity/records/*.golden.json`

**Interfaces:**
- Consumes: `parity.harness.offline`, `parity.normalize.normalize_document`, `core.blocks.schema.encode_document`, `parity/cases.json`.
- Produces: one `parity/records/<id with '/' → '__'>.golden.json` per case, shaped:

```
{
  "parityVersion": 1,
  "caseId":     string,
  "aggregator": string,
  "fixture":    string,
  "options":    object,
  "article":    { "name", "identifier", "author", "date", "plainText" },
  "document":   { "version": 1, "blocks": [...] },   // normalized
  "images":     [ { "key", "sourceUrl", "contentType", "width", "height", "byteSize" } ]
}
```

- [ ] **Step 1: Write the failing test**

```python
# core/tests/test_parity_corpus.py  (append)
RECORDS = PARITY / "records"


def _record_path(case_id: str) -> Path:
    return RECORDS / f"{case_id.replace('/', '__')}.golden.json"


def test_every_case_has_a_record():
    missing = [case["id"] for case in CASES["cases"] if not _record_path(case["id"]).is_file()]
    assert not missing, f"cases with no golden record: {missing}"


def test_records_are_well_formed():
    for case in CASES["cases"]:
        record = json.loads(_record_path(case["id"]).read_text())
        assert record["parityVersion"] == 1
        assert record["caseId"] == case["id"]
        assert record["document"]["version"] == 1
        assert isinstance(record["document"]["blocks"], list)
        for entry in record["images"]:
            assert set(entry) == {
                "key", "sourceUrl", "contentType", "width", "height", "byteSize",
            }
        # The contract forbids this field existing at all.
        assert "contentHash" not in json.dumps(record)


def test_no_record_carries_an_unnormalized_ref():
    import re

    stored = re.compile(r"yana-img://(?!\{img:\d+\})")
    for case in CASES["cases"]:
        text = _record_path(case["id"]).read_text()
        assert not stored.search(text), f"unnormalized ref in {case['id']}"
```

- [ ] **Step 2: Run it to confirm it fails**

```bash
uv run pytest core/tests/test_parity_corpus.py -v -k record
```

Expected: FAIL — no records exist.

- [ ] **Step 3: Find the pipeline entry point**

The generator must drive the same code path aggregation uses, not a parallel one.

```bash
grep -n "def convert_article" -A 20 core/blocks/conversion.py
grep -n "def aggregate\|def run\|def enrich_articles\|def finalize_articles" core/aggregators/base.py
grep -n "convert_article" -r core --include='*.py' | grep -v __pycache__
```

Record how `test_aggregator --dry-run` reaches the pipeline; the generator mirrors it.

- [ ] **Step 4: Write the generator**

```python
# parity/generate.py
"""
Generate golden records from the current Python pipeline.

Run before the TypeScript port begins, and before phase 14 removes Python. The
records are the oracle that outlives this code.
"""

import argparse
import json
import os
import sys
from pathlib import Path

import django

PARITY = Path(__file__).resolve().parent
sys.path.insert(0, str(PARITY.parent))
os.environ.setdefault("DJANGO_SETTINGS_MODULE", "yana.settings")
django.setup()

from django.contrib.auth.models import User  # noqa: E402
from django.test.utils import setup_test_environment  # noqa: E402

from core.blocks.schema import encode_document  # noqa: E402
from core.models import ArticleImage, Feed  # noqa: E402
from parity.harness import ImageProvenance, offline  # noqa: E402
from parity.normalize import normalize_document  # noqa: E402

RECORDS = PARITY / "records"


def record_path(case_id: str) -> Path:
    return RECORDS / f"{case_id.replace('/', '__')}.golden.json"


def run_case(case: dict, user: User) -> dict:
    """Drive one case through the pipeline and build its golden record."""
    from core.aggregators.registry import AggregatorRegistry

    feed = Feed.objects.create(
        name=f"parity:{case['id']}",
        aggregator=case["aggregator"],
        identifier=case["identifier"],
        options=case["options"],
        user=user,
        daily_limit=1000,
    )

    provenance = ImageProvenance()
    aggregator_class = AggregatorRegistry.get(case["aggregator"])
    aggregator = aggregator_class(feed)

    with offline(case, provenance):
        # Mirrors the path test_aggregator --dry-run takes; confirm against Step 3.
        raw = aggregator.parse_to_raw_articles(aggregator.fetch_source_data(limit=1))
        enriched = aggregator.finalize_articles(aggregator.enrich_articles(raw[:1]))

    assert enriched, f"{case['id']} produced no article"
    article = enriched[0]

    blocks = article.blocks if hasattr(article, "blocks") else []
    document, images = normalize_document(
        encode_document(list(blocks)), provenance.hash_to_url
    )

    by_url = {
        provenance.hash_to_url[image.content_hash]: image
        for image in ArticleImage.objects.all()
        if image.content_hash in provenance.hash_to_url
    }
    for entry in images:
        stored = by_url.get(entry["sourceUrl"])
        entry.update(
            {
                "contentType": stored.content_type if stored else "",
                "width": stored.width if stored else None,
                "height": stored.height if stored else None,
                "byteSize": stored.byte_size if stored else 0,
            }
        )

    return {
        "parityVersion": 1,
        "caseId": case["id"],
        "aggregator": case["aggregator"],
        "fixture": case["fixture"],
        "options": case["options"],
        "article": {
            "name": getattr(article, "name", ""),
            "identifier": getattr(article, "identifier", ""),
            "author": getattr(article, "author", ""),
            "date": getattr(article, "date", None).isoformat()
            if getattr(article, "date", None)
            else None,
            "plainText": getattr(article, "plain_text", ""),
        },
        "document": document,
        "images": images,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--case", action="append", help="case id; repeatable")
    args = parser.parse_args()

    setup_test_environment()
    RECORDS.mkdir(parents=True, exist_ok=True)

    cases = json.loads((PARITY / "cases.json").read_text())["cases"]
    if args.case:
        wanted = set(args.case)
        cases = [case for case in cases if case["id"] in wanted]
        if not cases:
            print(f"no such case: {sorted(wanted)}", file=sys.stderr)
            return 1

    user, _ = User.objects.get_or_create(username="parity")

    failures = 0
    for case in cases:
        try:
            record = run_case(case, user)
        except Exception as error:  # noqa: BLE001 - report and continue
            print(f"FAIL {case['id']}: {type(error).__name__}: {error}", file=sys.stderr)
            failures += 1
            continue
        # sort_keys is what makes two runs byte-identical.
        record_path(case["id"]).write_text(
            json.dumps(record, indent=2, sort_keys=True, ensure_ascii=False) + "\n"
        )
        blocks = len(record["document"]["blocks"])
        print(f"ok   {case['id']}  ({blocks} blocks, {len(record['images'])} images)")

    print(f"\n{len(cases) - failures}/{len(cases)} cases generated")
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
```

> **Run against a scratch database.** The generator writes `Feed` and `ArticleImage` rows. Point `DATABASE_URL` (or the settings equivalent) at a throwaway file so the development database is untouched.

- [ ] **Step 5: Generate one case and inspect it by eye**

```bash
uv run python parity/generate.py --case oglaf/basic
cat parity/records/oglaf__basic.golden.json
```

`oglaf` first because it is the smallest fixture (3.8 KB) — failures are legible. Expected: a record with a non-empty `document.blocks`. Read it and confirm the blocks describe the comic: this is the one manual sanity check in the phase, and it is the difference between pinning correct behavior and pinning a bug.

- [ ] **Step 6: Generate the full corpus**

```bash
uv run python parity/generate.py
```

Cases that fail print a reason. Fix the case definition (wrong `sourceUrl`, missing option) rather than weakening the generator. A case that cannot produce an article is a case that teaches the port nothing.

- [ ] **Step 7: Run the tests to verify they pass**

```bash
uv run pytest core/tests/test_parity_corpus.py -v
```

Expected: PASS.

- [ ] **Step 8: Prove determinism**

```bash
uv run python parity/generate.py
git diff --stat parity/records/
```

Expected: **no diff.** Any diff is a nondeterminism defect — most likely a timestamp, a `set` iteration order, or a dict ordering leak. Fix the cause; do not paper over it by sorting the output afterwards.

- [ ] **Step 9: Commit**

```bash
git add parity/generate.py parity/records core/tests/test_parity_corpus.py
git commit -m "test(parity): Generate the golden corpus

One record per case, pinning the current pipeline's block output. Generation is
deterministic -- a second run must produce no diff -- and records omit content
hashes entirely, since Pillow and sharp cannot agree on compressed bytes.

This is the oracle phases 11a-11c check against, and it must exist before
phase 14 deletes the code that produced it."
```

---

### Task 7: Guard the corpus in CI

**Files:**
- Modify: `core/tests/test_parity_corpus.py`
- Modify: `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: everything above.
- Produces: a CI job step that fails if records drift from what the current pipeline produces.

- [ ] **Step 1: Write the failing test**

```python
# core/tests/test_parity_corpus.py  (append)
import pytest


@pytest.mark.django_db
def test_records_match_the_current_pipeline():
    """
    Regenerating must reproduce the committed records exactly.

    This is what stops a change to extraction from silently invalidating the
    oracle: if behavior changes on purpose, regenerate and say so in the commit.
    """
    from django.contrib.auth.models import User

    from parity.generate import run_case

    user, _ = User.objects.get_or_create(username="parity")
    for case in CASES["cases"]:
        expected = json.loads(_record_path(case["id"]).read_text())
        actual = run_case(case, user)
        assert actual == expected, (
            f"{case['id']} drifted. If intentional, run "
            f"`uv run python parity/generate.py --case {case['id']}` and explain "
            f"the diff in your commit message."
        )
```

- [ ] **Step 2: Run it**

```bash
uv run pytest core/tests/test_parity_corpus.py::test_records_match_the_current_pipeline -v
```

Expected: PASS — Task 6 just generated these records from this code.

- [ ] **Step 3: Add the CI step**

In `.github/workflows/ci.yml`, inside the `test` job, after `Run Pytest`:

```yaml
    - name: Verify parity corpus
      run: uv run pytest core/tests/test_parity_corpus.py core/tests/test_parity_normalize.py core/tests/test_parity_harness.py -v
```

A separate step from the main suite so a corpus drift is legible in the job list rather than buried in pytest output.

- [ ] **Step 4: Verify the whole suite is green**

```bash
uv run ruff check . --fix && uv run ruff format . && uv run mypy . && uv run pytest
```

Expected: all pass. `parity/` is included — it is normal repository code and holds to the same standards.

- [ ] **Step 5: Commit**

```bash
git add core/tests/test_parity_corpus.py .github/workflows/ci.yml
git commit -m "ci(parity): Fail the build when golden records drift

Its own step rather than part of the main suite, so a drift is legible in the
job list. Intentional extraction changes regenerate the records and explain the
diff; unintentional ones stop here instead of quietly invalidating the oracle
the TypeScript port depends on."
```

---

## Self-Review

**Spec coverage.** Against the parity-contract section of the direction record:

| Spec requirement | Task |
|---|---|
| Goldens generated from Python once, committed | 6 |
| Refs normalized to source-URL keys | 5 |
| `contentHash` never compared | 5, 6 (asserted in `test_records_well_formed`) |
| `contentType` / `width` / `height` exact | 6 (manifest fields; asserted in 11a) |
| `byteSize` tolerance band | 6 emits it; the ±25% comparison lands in 11a |
| Recover the 9 archived fixtures | 1 |
| Capture `ars_technica`, `the_verge` | 3 Step 6 |
| Staleness explicitly acceptable | 1 Step 5 (README) |
| Runs before Python is deleted | This phase is 0 |
| Determinism | 6 Step 8, 7 Step 1 |

Two items are deliberately deferred to 11a rather than missing here: the ±25% byte-size comparison and the TypeScript half of `normalize_document`. Both are comparison-side concerns with no Python counterpart to write.

**Placeholder scan.** No TBDs. Three steps direct the engineer to inspect real signatures before writing against them (4 Step 3, 4 Step 5, 6 Step 3) rather than trusting names in this document — deliberate, because `fetch_single_image`'s return shape and `image_store`'s entry point were not verified while writing this plan, and a stub that is shape-approximate produces goldens that are wrong in a way tests will not catch.

**Type consistency.** `ImageProvenance.hash_to_url` is `dict[str, str]` in Task 4 and consumed as such in Tasks 5–6. `normalize_document` returns `tuple[dict, list[dict]]` in Task 5 and is destructured that way in Task 6. Manifest entry keys — `key`, `sourceUrl`, `contentType`, `width`, `height`, `byteSize` — match between Task 5's output, Task 6's enrichment, and Task 6's `test_records_are_well_formed`. Record filenames use `'/' → '__'` consistently in `record_path` (Task 6) and `_record_path` (Task 6's test).

**One known risk.** Task 6 Step 4 guesses the pipeline entry sequence (`fetch_source_data` → `parse_to_raw_articles` → `enrich_articles` → `finalize_articles`) from `base.py`'s method names. Step 3 exists to verify it before the code is written. If `test_aggregator --dry-run` reaches the pipeline differently, mirror *that* — a generator driving a parallel code path would pin behavior aggregation never produces.
