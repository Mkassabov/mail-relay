CREATE TABLE IF NOT EXISTS whitelist (
  sender TEXT NOT NULL COLLATE NOCASE,
  alias TEXT NOT NULL COLLATE NOCASE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (sender, alias)
);

CREATE TABLE IF NOT EXISTS held_requests (
  id TEXT PRIMARY KEY,
  sender TEXT NOT NULL COLLATE NOCASE,
  alias TEXT NOT NULL COLLATE NOCASE,
  subject TEXT,
  received_at TEXT NOT NULL DEFAULT (datetime('now')),
  status TEXT NOT NULL DEFAULT 'pending',
  r2_key TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_held_requests_status ON held_requests(status);
CREATE INDEX IF NOT EXISTS idx_held_requests_sender_alias ON held_requests(sender, alias);
