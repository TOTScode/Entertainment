-- Один действующий прогноз на матч: исход или точный счёт, но не оба сразу.
-- Если у игрока уже есть оба, прогноз на точный счёт отменяется, ставка возвращается.
INSERT INTO transactions (user_id, amount, type, ref, created_at)
SELECT s.user_id, s.stake, 'refund', 'prediction:' || s.id, CAST(strftime('%s', 'now') AS INTEGER)
FROM predictions s
WHERE s.status = 'active' AND s.market = 'score'
  AND EXISTS (SELECT 1 FROM predictions o WHERE o.user_id = s.user_id AND o.match_id = s.match_id AND o.status = 'active' AND o.market = '1x2');

UPDATE predictions SET status = 'cancelled', updated_at = CAST(strftime('%s', 'now') AS INTEGER)
WHERE status = 'active' AND market = 'score'
  AND EXISTS (SELECT 1 FROM predictions o WHERE o.user_id = predictions.user_id AND o.match_id = predictions.match_id AND o.status = 'active' AND o.market = '1x2');

DROP INDEX predictions_one_active;
CREATE UNIQUE INDEX predictions_one_active ON predictions(user_id, match_id) WHERE status = 'active';
