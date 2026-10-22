-- Cover the reader table's composite binding foreign key; no access or eligibility changes.
BEGIN;
CREATE INDEX social_visibility_binding ON social_sync.website_visibility(publication_key,work_id);
COMMIT;
