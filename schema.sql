CREATE TABLE IF NOT EXISTS users (
  user_id TEXT PRIMARY KEY,
  user_name TEXT DEFAULT '',
  point REAL DEFAULT 0,
  last_battle_at INTEGER DEFAULT 0,
  insurance_used_at INTEGER DEFAULT 0,
  bonus_multiplier REAL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS battles (
  id TEXT PRIMARY KEY,
  player_a TEXT,
  player_b TEXT,
  bet_a REAL,
  bet_b REAL,
  status TEXT,
  thread_id TEXT,
  result TEXT,
  created_at INTEGER
);

CREATE TABLE IF NOT EXISTS requests (
  id TEXT PRIMARY KEY,
  type TEXT,
  user_id TEXT,
  data TEXT,
  calculated_point REAL,
  status TEXT,
  created_at INTEGER
);

CREATE TABLE IF NOT EXISTS weekly (
  id INTEGER PRIMARY KEY,
  multiplied_difficulty TEXT
);

CREATE TABLE IF NOT EXISTS score_submissions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT,
  difficulty TEXT,
  week_id INTEGER,
  UNIQUE(user_id, difficulty, week_id)
);

CREATE TABLE IF NOT EXISTS logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT,
  action TEXT,
  value REAL,
  created_at INTEGER
);

CREATE TABLE IF NOT EXISTS songs (
  song_id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  artist TEXT NOT NULL,
  version TEXT NOT NULL,
  chart_type TEXT NOT NULL,
  synced_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS song_charts (
  song_id TEXT NOT NULL,
  chart_set TEXT NOT NULL,
  difficulty TEXT NOT NULL,
  level TEXT NOT NULL,
  level_value INTEGER,
  synced_at INTEGER NOT NULL,
  PRIMARY KEY (song_id, chart_set, difficulty)
);
