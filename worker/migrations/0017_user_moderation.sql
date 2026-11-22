-- Preserve accounts, balances and all historical activity.
ALTER TABLE users ADD COLUMN blocked_at INTEGER;
ALTER TABLE users ADD COLUMN blocked_by INTEGER;
ALTER TABLE users ADD COLUMN block_reason TEXT;
CREATE TRIGGER blocked_prediction_insert BEFORE INSERT ON predictions WHEN EXISTS(SELECT 1 FROM users WHERE id=NEW.user_id AND blocked_at IS NOT NULL)
BEGIN SELECT RAISE(ABORT,'account_blocked'); END;
CREATE TRIGGER blocked_quiz_answer_insert BEFORE INSERT ON quiz_answers WHEN EXISTS(SELECT 1 FROM users WHERE id=NEW.user_id AND blocked_at IS NOT NULL)
BEGIN SELECT RAISE(ABORT,'account_blocked'); END;
CREATE TRIGGER blocked_quiz_answer_update BEFORE UPDATE ON quiz_answers WHEN EXISTS(SELECT 1 FROM users WHERE id=NEW.user_id AND blocked_at IS NOT NULL)
BEGIN SELECT RAISE(ABORT,'account_blocked'); END;
CREATE TRIGGER blocked_final_entry BEFORE INSERT ON final_entries WHEN EXISTS(SELECT 1 FROM users WHERE id=NEW.user_id AND blocked_at IS NOT NULL)
BEGIN SELECT RAISE(ABORT,'account_blocked'); END;
CREATE TRIGGER blocked_final_answer BEFORE INSERT ON final_submissions WHEN EXISTS(SELECT 1 FROM users WHERE id=NEW.user_id AND blocked_at IS NOT NULL)
BEGIN SELECT RAISE(ABORT,'account_blocked'); END;
CREATE TRIGGER blocked_final_tiebreak BEFORE INSERT ON final_tiebreak_answers WHEN EXISTS(SELECT 1 FROM users WHERE id=NEW.user_id AND blocked_at IS NOT NULL)
BEGIN SELECT RAISE(ABORT,'account_blocked'); END;
CREATE TRIGGER blocked_profile_visibility BEFORE UPDATE OF public_profile,public_avatar ON users WHEN NEW.blocked_at IS NOT NULL AND (NEW.public_profile=1 OR NEW.public_avatar=1)
BEGIN SELECT RAISE(ABORT,'account_blocked'); END;
