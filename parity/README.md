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
