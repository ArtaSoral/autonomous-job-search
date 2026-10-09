CREATE TABLE IF NOT EXISTS openai_auth_meta(name TEXT PRIMARY KEY,value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS openai_auth_pending(state TEXT PRIMARY KEY,browser_hash TEXT NOT NULL,secrets TEXT NOT NULL,expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS openai_accounts(client_id TEXT PRIMARY KEY,subject TEXT NOT NULL,email TEXT NOT NULL,secrets TEXT,expires_at INTEGER NOT NULL,models TEXT NOT NULL DEFAULT '[]',fast_model TEXT NOT NULL DEFAULT '',strong_model TEXT NOT NULL DEFAULT '');
