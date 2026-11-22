-- New writes only. Preserve existing predictions and their settlement/history.
DROP TRIGGER predictions_open_insert;
CREATE TRIGGER predictions_open_insert BEFORE INSERT ON predictions
WHEN (SELECT status!='scheduled' OR start_time<=NEW.created_at FROM matches WHERE id=NEW.match_id)
BEGIN SELECT RAISE(ABORT,'match_closed'); END;
DROP TRIGGER predictions_open_change;
CREATE TRIGGER predictions_open_change BEFORE UPDATE OF status ON predictions
WHEN NEW.status IN ('replaced','cancelled') AND (SELECT status!='scheduled' OR start_time<=NEW.updated_at FROM matches WHERE id=NEW.match_id)
BEGIN SELECT RAISE(ABORT,'match_closed'); END;
