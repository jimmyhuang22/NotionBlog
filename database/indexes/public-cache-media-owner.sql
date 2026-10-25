-- Optional performance-only installation; not part of an automatic migration batch.
-- Run this single statement outside a transaction on an explicitly approved owner session.
-- See docs/PUBLIC_CACHE_WITHDRAWAL_INDEX.md for prerequisites, verification and failure handling.
CREATE INDEX CONCURRENTLY media_withdraw_owner_asset
  ON nb_v2.media USING btree (owner_page_id, asset_id);
