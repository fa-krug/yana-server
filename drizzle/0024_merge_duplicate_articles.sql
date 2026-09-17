-- Merge articles this feed already stored twice because the publisher served
-- one document under two paths.
--
-- The cause is fixed going forward by `articles.external_id` (migration 0023):
-- `handleAggregateJob()` now matches a feed item by its own guid before falling
-- back to the URL, so an article that moves is matched rather than re-inserted.
-- That does nothing for the rows already written, which is what this does, once.
--
-- WHAT COUNTS AS THE SAME ARTICLE HERE. Not the guid -- these rows predate the
-- column and have none, which is the whole reason they need a separate rule.
-- Four conditions, all required, because the asymmetry of being wrong is
-- severe: a missed pair leaves a visible duplicate the reader can delete, while
-- a wrong merge destroys an article nobody knows is gone.
--
--   * the same feed,
--   * the same title, verbatim,
--   * the same final path segment of the URL -- the publisher's own document
--     name (`italien-meloni-124.html`), which is what stays put while the
--     section prefix moves, and
--   * a non-empty final segment, which is what keeps a feed of directory-style
--     URLs (`.../a-post/`, every one of them ending in nothing) from collapsing
--     into a single row.
--
-- Title equality is doing real work in that list, not decoration. Tagesschau
-- ships several items titled just "tagesschau" per day; they differ in document
-- name, so the third condition separates them -- and conversely two genuinely
-- different articles that happened to share a document name across sections
-- would be separated by the title. Requiring both means a merge needs the
-- publisher to agree with itself twice.
--
-- THE SURVIVOR IS THE OLDEST ROW, and that is not arbitrary. `created_at` is
-- the timeline's ordering key and the sync cursor (see schema/articles.ts), and
-- the row id is what every paired client already has synced, so keeping the
-- oldest keeps both stable -- the reader's timeline does not reshuffle and the
-- article does not reappear as new. It adopts the *newest* duplicate's
-- identifier, which is the most recent URL the feed was seen to use.
--
-- `content_hash` is deliberately NOT nulled. Nothing this migration writes is a
-- fingerprint input -- the hash covers name/content/date/author/icon, never the
-- URL -- so the survivor's hash still describes its own block tree correctly,
-- and nulling it would force a full rewrite plus, on an AI-enabled feed, a paid
-- provider request per merged article, to re-derive what is already there. This
-- is the same rule schema/articles.ts states for writers that only flip
-- read/starred.

--
-- ORDER IS LOAD-BEARING, and so is `count(*) > 1` rather than
-- `count(DISTINCT identifier) > 1`. The survivor adopts a loser's URL, so after
-- the first statement the group no longer has two distinct identifiers -- a
-- DISTINCT test would re-evaluate to false and leave the second and third
-- statements matching nothing at all, silently keeping every duplicate. A row
-- count is stable across the update, and it is equivalent to begin with:
-- `(feed_id, identifier)` was already the uniqueness the aggregate handler
-- enforced, so two rows in one feed cannot have shared a URL before this ran.
-- The tombstone is written before the delete, which every hard-delete path here
-- owes /api/v1's sync `removed` list; the block tree goes with the row by
-- cascade.

WITH docs AS (
  SELECT
    a.id, a.feed_id, a.name, a.identifier, a.read, a.starred, f.user_id,
    replace(a.identifier, rtrim(a.identifier, replace(a.identifier, '/', '')), '') AS doc
  FROM articles a
  JOIN feeds f ON f.id = a.feed_id
  WHERE a.identifier LIKE 'http%://%/%'
    AND a.identifier NOT LIKE '%?%'
    AND a.identifier NOT LIKE '%#%'
),
dupes AS (
  SELECT feed_id, doc, name,
         min(id) AS keep_id,
         max(id) AS newest_id,
         max(read) AS merged_read,
         max(starred) AS merged_starred
  FROM docs
  WHERE doc <> ''
  GROUP BY feed_id, doc, name
  HAVING count(*) > 1
)
UPDATE articles SET
  identifier = (
    SELECT d.identifier FROM docs d
    WHERE d.id = (SELECT g.newest_id FROM dupes g WHERE g.keep_id = articles.id)
  ),
  read = (SELECT g.merged_read FROM dupes g WHERE g.keep_id = articles.id),
  starred = (SELECT g.merged_starred FROM dupes g WHERE g.keep_id = articles.id),
  -- Bumped by hand because `$onUpdate` is client-side, and without it the
  -- survivor's new URL and merged read/starred would never reach a paired
  -- client: /api/v1's sync `updated` stream is ordered by this column.
  updated_at = unixepoch()
WHERE articles.id IN (SELECT keep_id FROM dupes);
--> statement-breakpoint
WITH docs AS (
  SELECT
    a.id, a.feed_id, a.name, a.identifier, a.read, a.starred, f.user_id,
    replace(a.identifier, rtrim(a.identifier, replace(a.identifier, '/', '')), '') AS doc
  FROM articles a
  JOIN feeds f ON f.id = a.feed_id
  WHERE a.identifier LIKE 'http%://%/%'
    AND a.identifier NOT LIKE '%?%'
    AND a.identifier NOT LIKE '%#%'
),
dupes AS (
  SELECT feed_id, doc, name,
         min(id) AS keep_id,
         max(id) AS newest_id,
         max(read) AS merged_read,
         max(starred) AS merged_starred
  FROM docs
  WHERE doc <> ''
  GROUP BY feed_id, doc, name
  HAVING count(*) > 1
)
INSERT INTO article_tombstones (article_id, user_id)
SELECT d.id, d.user_id
FROM docs d
JOIN dupes g ON g.feed_id = d.feed_id AND g.doc = d.doc AND g.name = d.name
WHERE d.id <> g.keep_id;
--> statement-breakpoint
WITH docs AS (
  SELECT
    a.id, a.feed_id, a.name, a.identifier, a.read, a.starred, f.user_id,
    replace(a.identifier, rtrim(a.identifier, replace(a.identifier, '/', '')), '') AS doc
  FROM articles a
  JOIN feeds f ON f.id = a.feed_id
  WHERE a.identifier LIKE 'http%://%/%'
    AND a.identifier NOT LIKE '%?%'
    AND a.identifier NOT LIKE '%#%'
),
dupes AS (
  SELECT feed_id, doc, name,
         min(id) AS keep_id,
         max(id) AS newest_id,
         max(read) AS merged_read,
         max(starred) AS merged_starred
  FROM docs
  WHERE doc <> ''
  GROUP BY feed_id, doc, name
  HAVING count(*) > 1
)
DELETE FROM articles WHERE id IN (
  SELECT d.id
  FROM docs d
  JOIN dupes g ON g.feed_id = d.feed_id AND g.doc = d.doc AND g.name = d.name
  WHERE d.id <> g.keep_id
);
