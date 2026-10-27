-- Прогнозы на матчи (этап 4).

-- Матчи. Основной источник — OddsPapi (op_id); для АПЛ, Бундеслиги, Ла Лиги и ЛЧ результат берётся из football-data.org (fd_id).
CREATE TABLE matches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tournament TEXT NOT NULL,                 -- PL, BL1, PD, CL, EL, ECL
  home TEXT NOT NULL,
  away TEXT NOT NULL,
  start_time INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'scheduled', -- scheduled, postponed, finished, cancelled
  home_score INTEGER,                       -- счёт основного времени
  away_score INTEGER,
  op_id TEXT UNIQUE,
  fd_id INTEGER UNIQUE,
  odds_updated_at INTEGER,
  settled_at INTEGER,
  settle_version INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);
CREATE INDEX matches_start ON matches(start_time);

-- Коэффициенты: market '1x2' (исходы 1, X, 2) и 'score' (исходы вида 2:1)
CREATE TABLE odds (
  match_id INTEGER NOT NULL REFERENCES matches(id),
  market TEXT NOT NULL,
  outcome TEXT NOT NULL,
  price REAL NOT NULL,
  PRIMARY KEY (match_id, market, outcome)
);

CREATE TABLE predictions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  match_id INTEGER NOT NULL REFERENCES matches(id),
  market TEXT NOT NULL,
  outcome TEXT NOT NULL,
  stake INTEGER NOT NULL,          -- в 1/10000 BIST, как в журнале
  price REAL NOT NULL,             -- коэффициент, зафиксированный при ставке
  commission INTEGER NOT NULL,     -- процент комиссии: 7 или 10
  status TEXT NOT NULL DEFAULT 'active', -- active, replaced, cancelled, won, lost, refunded
  payout INTEGER,                  -- в 1/10000 BIST
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  settled_at INTEGER
);
CREATE INDEX predictions_user ON predictions(user_id, id DESC);
CREATE INDEX predictions_match ON predictions(match_id, status);
-- Один действующий прогноз на матч и рынок
CREATE UNIQUE INDEX predictions_one_active ON predictions(user_id, match_id, market) WHERE status = 'active';

-- Ставку, замену и отмену можно сделать только до начала матча
CREATE TRIGGER predictions_open_insert
BEFORE INSERT ON predictions
WHEN (SELECT status != 'scheduled' AND status != 'postponed' OR start_time <= NEW.created_at FROM matches WHERE id = NEW.match_id)
BEGIN
  SELECT RAISE(ABORT, 'match_closed');
END;

CREATE TRIGGER predictions_open_change
BEFORE UPDATE OF status ON predictions
WHEN NEW.status IN ('replaced', 'cancelled')
  AND (SELECT status != 'scheduled' AND status != 'postponed' OR start_time <= NEW.updated_at FROM matches WHERE id = NEW.match_id)
BEGIN
  SELECT RAISE(ABORT, 'match_closed');
END;

-- Каждая ставка списывается, возвращается и выплачивается не больше одного раза
CREATE UNIQUE INDEX transactions_prediction_once ON transactions(type, ref)
WHERE type IN ('bet', 'refund', 'payout', 'payout_reversal');

-- Служебные значения: справочник рынков, учёт запросов к API
CREATE TABLE api_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
