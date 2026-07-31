# Parity corpus

Golden records pinning the Python aggregator pipeline's output, so the TypeScript
port can be checked against it after Python is gone.

The Python pipeline now lives in `old/`, read-only and not runnable as configured
(see `CLAUDE.md`). This corpus, not that tree, is the oracle.

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

## Regenerating — you cannot, and should not

`parity/generate.py`, which this section used to document, was never committed
(`git log --all -- parity/generate.py` is empty), and the Django tree it drove now
sits in `old/` where nothing installs its environment or runs it. Regenerating a
record would mean reconstructing both.

That is by design rather than a gap to close: the corpus is **frozen**. Its whole
value is that both implementations are compared against identical, unchanging
bytes. A record that gets refreshed proves nothing.

Never hand-edit a record either. If a golden looks wrong, the port is wrong until
proven otherwise; if a golden really is wrong, say so in the commit message and
explain the fix rather than quietly rewriting the file.
