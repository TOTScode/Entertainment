-- Launch is 2026-12-01 00:00 Europe/Minsk. Historical rows are retained, not reclassified.
ALTER TABLE predictions ADD COLUMN is_admin_test INTEGER NOT NULL DEFAULT 0 CHECK(is_admin_test IN (0,1));
CREATE TRIGGER seasons_launch_insert BEFORE INSERT ON seasons WHEN NEW.starts_at<1796072400
BEGIN SELECT RAISE(ABORT,'season_before_launch'); END;
CREATE TRIGGER seasons_launch_update BEFORE UPDATE OF starts_at ON seasons WHEN NEW.starts_at<1796072400
BEGIN SELECT RAISE(ABORT,'season_before_launch'); END;
DROP TRIGGER predictions_open_insert;
CREATE TRIGGER predictions_open_insert BEFORE INSERT ON predictions
WHEN NEW.is_admin_test=0 AND (SELECT status NOT IN ('scheduled','postponed') OR start_time<=NEW.created_at FROM matches WHERE id=NEW.match_id)
BEGIN SELECT RAISE(ABORT,'match_closed'); END;
DROP TRIGGER predictions_open_change;
CREATE TRIGGER predictions_open_change BEFORE UPDATE OF status ON predictions
WHEN OLD.is_admin_test=0 AND NEW.status IN ('replaced','cancelled') AND (SELECT status NOT IN ('scheduled','postponed') OR start_time<=NEW.updated_at FROM matches WHERE id=NEW.match_id)
BEGIN SELECT RAISE(ABORT,'match_closed'); END;
DROP TRIGGER predictions_season_insert;
CREATE TRIGGER predictions_season_insert BEFORE INSERT ON predictions
WHEN NEW.is_admin_test=0 AND (NEW.created_at<1796072400 OR EXISTS(SELECT 1 FROM seasons s JOIN matches m ON m.id=NEW.match_id WHERE NEW.created_at>=s.starts_at AND NEW.created_at<s.ends_at AND (s.closed_at IS NOT NULL OR m.start_time>=s.ends_at)))
BEGIN SELECT RAISE(ABORT,'match_closed'); END;
CREATE TRIGGER prediction_admin_mode_audit AFTER INSERT ON predictions WHEN NEW.is_admin_test=1 BEGIN
 INSERT INTO content_versions(kind,target_id,source,snapshot,created_at,actor_id,reason) VALUES('admin_prediction',NEW.id,'authorized admin API',json_object('is_admin_test',1,'match_id',NEW.match_id),NEW.created_at,NEW.user_id,'Excluded from seasonal prediction statistics; ordinary BIST balance');
END;
