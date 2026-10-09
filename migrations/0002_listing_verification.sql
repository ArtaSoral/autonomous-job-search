ALTER TABLE jobs ADD COLUMN last_verified_at TEXT;
ALTER TABLE jobs ADD COLUMN normalized_employer TEXT NOT NULL DEFAULT '';
CREATE INDEX jobs_employer_normalized ON jobs(normalized_employer);
