-- Ежедневные снимки общего рейтинга: по ним считается изменение места за сутки.
CREATE TABLE rank_snapshots (
  day TEXT NOT NULL,          -- дата по Москве, YYYY-MM-DD
  user_id INTEGER NOT NULL,
  rank INTEGER NOT NULL,
  PRIMARY KEY (day, user_id)
);

-- История операций пользователя листается по id в обратном порядке
CREATE INDEX transactions_user_id_desc ON transactions(user_id, id DESC);
