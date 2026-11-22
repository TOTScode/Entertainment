-- Additive migration. No balances, answers, predictions or ledger rows are deleted.
ALTER TABLE users ADD COLUMN public_profile INTEGER NOT NULL DEFAULT 0 CHECK(public_profile IN (0,1));
ALTER TABLE users ADD COLUMN public_avatar INTEGER NOT NULL DEFAULT 0 CHECK(public_avatar IN (0,1));
ALTER TABLE users ADD COLUMN marketing_opt_in INTEGER NOT NULL DEFAULT 0 CHECK(marketing_opt_in IN (0,1));
ALTER TABLE users ADD COLUMN marketing_opt_out INTEGER NOT NULL DEFAULT 0 CHECK(marketing_opt_out IN (0,1));
CREATE TABLE privacy_events (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, purpose TEXT NOT NULL, granted INTEGER NOT NULL, policy_version TEXT, created_at INTEGER NOT NULL);
CREATE TABLE policy_documents (version TEXT PRIMARY KEY, body TEXT NOT NULL, published_at INTEGER, published_by INTEGER);
CREATE TABLE user_requests (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, kind TEXT NOT NULL, target_type TEXT, target_id INTEGER, message TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open', created_at INTEGER NOT NULL, resolution TEXT, resolved_by INTEGER, resolved_at INTEGER);
CREATE INDEX requests_user ON user_requests(user_id,id);
CREATE TABLE seasons (id TEXT PRIMARY KEY, starts_at INTEGER NOT NULL UNIQUE, ends_at INTEGER NOT NULL, opening_units INTEGER, activated_at INTEGER, closed_at INTEGER, qualification_frozen_at INTEGER);
CREATE TABLE final_rules (season_id TEXT PRIMARY KEY REFERENCES seasons(id), version INTEGER NOT NULL DEFAULT 1, body TEXT NOT NULL, published_at INTEGER, published_by INTEGER, frozen_at INTEGER);
CREATE TABLE season_participants (season_id TEXT NOT NULL, user_id INTEGER NOT NULL, qualified INTEGER NOT NULL, statistics TEXT NOT NULL, frozen_at INTEGER NOT NULL, PRIMARY KEY(season_id,user_id));
CREATE TABLE season_summaries (season_id TEXT NOT NULL,user_id INTEGER NOT NULL,statistics TEXT NOT NULL,closed_at INTEGER NOT NULL,closing_units INTEGER NOT NULL,PRIMARY KEY(season_id,user_id));
CREATE TABLE finalist_decisions (id INTEGER PRIMARY KEY,season_id TEXT NOT NULL,user_id INTEGER NOT NULL,admitted INTEGER NOT NULL,reason TEXT NOT NULL,admin_id INTEGER NOT NULL,created_at INTEGER NOT NULL);
CREATE TABLE final_entries (season_id TEXT NOT NULL,user_id INTEGER NOT NULL,entered_at INTEGER NOT NULL,PRIMARY KEY(season_id,user_id));
CREATE TABLE final_submissions (season_id TEXT NOT NULL,user_id INTEGER NOT NULL,round INTEGER NOT NULL,answers TEXT NOT NULL,submitted_at INTEGER NOT NULL,score REAL,reviewed_by INTEGER,reason TEXT,PRIMARY KEY(season_id,user_id,round));
CREATE TABLE content_versions (id INTEGER PRIMARY KEY,kind TEXT NOT NULL,target_id INTEGER NOT NULL,source TEXT NOT NULL,snapshot TEXT NOT NULL,created_at INTEGER NOT NULL,actor_id INTEGER,reason TEXT);
ALTER TABLE quiz_questions ADD COLUMN voided_at INTEGER;
ALTER TABLE quiz_questions ADD COLUMN source TEXT NOT NULL DEFAULT 'legacy: источник требует проверки';
ALTER TABLE quiz_questions ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE quizzes ADD COLUMN attempts_limit INTEGER;
ALTER TABLE quizzes ADD COLUMN time_limit INTEGER;
-- Freeze settings of existing quizzes at migration, rather than reinterpret attempts later.
UPDATE quizzes SET attempts_limit = COALESCE((SELECT json_extract(value,'$.attempts') FROM api_state WHERE key='quiz_settings'),1), time_limit = COALESCE((SELECT json_extract(value,'$.time_limit') FROM api_state WHERE key='quiz_settings'),60);
INSERT INTO content_versions(kind,target_id,source,snapshot,created_at)
SELECT 'question',id,source,json_object('text',text,'answers',answers,'media_id',media_id,'version',version),unixepoch() FROM quiz_questions;
INSERT INTO content_versions(kind,target_id,source,snapshot,created_at)
SELECT 'match',id,'legacy: op_id/fd_id',json_object('home',home,'away',away,'op_id',op_id,'fd_id',fd_id,'home_score',home_score,'away_score',away_score,'settle_version',settle_version),updated_at FROM matches;
CREATE UNIQUE INDEX transactions_season_once ON transactions(user_id,ref) WHERE type='season_opening';
CREATE UNIQUE INDEX transactions_quiz_reversal_once ON transactions(user_id,ref) WHERE type='quiz_reward_reversal';
DROP TRIGGER transactions_no_overdraft;
CREATE TRIGGER transactions_no_overdraft BEFORE INSERT ON transactions
WHEN NEW.amount < 0 AND NEW.type NOT IN ('payout_reversal','quiz_reward_reversal','season_opening')
AND (SELECT COALESCE(SUM(amount),0) FROM transactions WHERE user_id=NEW.user_id)+NEW.amount<0
BEGIN SELECT RAISE(ABORT,'insufficient_balance'); END;
-- Provenance for every subsequent question edit and result update; values never overwrite old versions.
CREATE TRIGGER question_version_insert AFTER INSERT ON quiz_questions BEGIN
 INSERT INTO content_versions(kind,target_id,source,snapshot,created_at) VALUES('question',NEW.id,NEW.source,json_object('text',NEW.text,'answers',NEW.answers,'media_id',NEW.media_id,'version',NEW.version,'voided_at',NEW.voided_at),unixepoch());
END;
CREATE TRIGGER question_version_update AFTER UPDATE ON quiz_questions BEGIN
 INSERT INTO content_versions(kind,target_id,source,snapshot,created_at) VALUES('question',NEW.id,NEW.source,json_object('text',NEW.text,'answers',NEW.answers,'media_id',NEW.media_id,'version',NEW.version,'voided_at',NEW.voided_at),unixepoch());
END;
CREATE TRIGGER match_version_update AFTER UPDATE ON matches BEGIN
 INSERT INTO content_versions(kind,target_id,source,snapshot,created_at) VALUES('match',NEW.id,CASE WHEN NEW.fd_id IS NOT NULL THEN 'football-data.org / OddsPapi' ELSE 'OddsPapi' END,json_object('status',NEW.status,'home_score',NEW.home_score,'away_score',NEW.away_score,'settle_version',NEW.settle_version,'op_id',NEW.op_id,'fd_id',NEW.fd_id),NEW.updated_at);
END;
CREATE TRIGGER ledger_no_delete BEFORE DELETE ON transactions BEGIN SELECT RAISE(ABORT,'ledger_append_only'); END;
-- Existing admin code annotates ref once after inserting its audit record. Amounts cannot be rewritten.
CREATE TRIGGER ledger_no_amount_update BEFORE UPDATE OF amount,user_id,type,created_at ON transactions BEGIN SELECT RAISE(ABORT,'ledger_append_only'); END;
CREATE TABLE final_tiebreaks (season_id TEXT PRIMARY KEY,body TEXT NOT NULL,participants TEXT NOT NULL,published_at INTEGER NOT NULL,admin_id INTEGER NOT NULL);
CREATE TABLE final_tiebreak_answers (season_id TEXT NOT NULL,user_id INTEGER NOT NULL,answer TEXT NOT NULL,submitted_at INTEGER NOT NULL,score REAL,reviewed_by INTEGER,reason TEXT,PRIMARY KEY(season_id,user_id));
-- Prevent a late/backdated ledger entry from silently changing the basis of a frozen admission list.
CREATE TRIGGER ledger_frozen_cutoff BEFORE INSERT ON transactions
WHEN EXISTS(SELECT 1 FROM seasons s WHERE s.qualification_frozen_at IS NOT NULL AND NEW.created_at>=s.starts_at AND NEW.created_at<s.qualification_frozen_at)
BEGIN SELECT RAISE(ABORT,'qualification_cutoff_locked'); END;
CREATE TRIGGER match_version_insert AFTER INSERT ON matches BEGIN
 INSERT INTO content_versions(kind,target_id,source,snapshot,created_at) VALUES('match',NEW.id,'OddsPapi/football-data.org (see op_id/fd_id)',json_object('home',NEW.home,'away',NEW.away,'op_id',NEW.op_id,'fd_id',NEW.fd_id,'start_time',NEW.start_time),NEW.updated_at);
END;
CREATE TRIGGER odds_version_insert AFTER INSERT ON odds BEGIN
 INSERT INTO content_versions(kind,target_id,source,snapshot,created_at) VALUES('odds',NEW.match_id,'OddsPapi',json_object('market',NEW.market,'outcome',NEW.outcome,'price',NEW.price),unixepoch());
END;
CREATE TRIGGER odds_version_update AFTER UPDATE ON odds BEGIN
 INSERT INTO content_versions(kind,target_id,source,snapshot,created_at) VALUES('odds',NEW.match_id,'OddsPapi',json_object('market',NEW.market,'outcome',NEW.outcome,'price',NEW.price),unixepoch());
END;
CREATE TRIGGER answer_version_insert AFTER INSERT ON quiz_answers BEGIN
 INSERT INTO content_versions(kind,target_id,source,snapshot,created_at,actor_id) VALUES('answer',NEW.question_id,'user submission',json_object('answer',NEW.answer,'attempts',NEW.attempts,'correct',NEW.correct,'question_version',(SELECT version FROM quiz_questions WHERE id=NEW.question_id)),COALESCE(NEW.answered_at,NEW.opened_at),NEW.user_id);
END;
CREATE TRIGGER answer_version_update AFTER UPDATE ON quiz_answers BEGIN
 INSERT INTO content_versions(kind,target_id,source,snapshot,created_at,actor_id) VALUES('answer',NEW.question_id,'user submission',json_object('answer',NEW.answer,'attempts',NEW.attempts,'correct',NEW.correct,'question_version',(SELECT version FROM quiz_questions WHERE id=NEW.question_id)),COALESCE(NEW.answered_at,NEW.opened_at),NEW.user_id);
END;
INSERT INTO content_versions(kind,target_id,source,snapshot,created_at,actor_id)
SELECT 'answer',question_id,'legacy answer state at migration',json_object('answer',answer,'attempts',attempts,'correct',correct,'question_version',1),COALESCE(answered_at,opened_at),user_id FROM quiz_answers;
CREATE INDEX content_answer_asof ON content_versions(kind,target_id,actor_id,created_at,id);
-- Immutability also at DB level, including concurrent publication requests.
CREATE TRIGGER published_rules_no_update BEFORE UPDATE OF body,published_at,published_by,version ON final_rules WHEN OLD.published_at IS NOT NULL BEGIN SELECT RAISE(ABORT,'published_rules_immutable'); END;
CREATE TRIGGER published_rules_no_delete BEFORE DELETE ON final_rules WHEN OLD.published_at IS NOT NULL BEGIN SELECT RAISE(ABORT,'published_rules_immutable'); END;
CREATE TRIGGER published_policy_no_update BEFORE UPDATE ON policy_documents WHEN OLD.published_at IS NOT NULL BEGIN SELECT RAISE(ABORT,'published_policy_immutable'); END;
CREATE TRIGGER published_policy_no_delete BEFORE DELETE ON policy_documents WHEN OLD.published_at IS NOT NULL BEGIN SELECT RAISE(ABORT,'published_policy_immutable'); END;
CREATE TRIGGER finalists_no_update BEFORE UPDATE ON season_participants BEGIN SELECT RAISE(ABORT,'frozen_finalists_immutable'); END;
CREATE TRIGGER finalists_no_delete BEFORE DELETE ON season_participants BEGIN SELECT RAISE(ABORT,'frozen_finalists_immutable'); END;
CREATE TRIGGER final_answers_no_rewrite BEFORE UPDATE OF answers,user_id,submitted_at,season_id,round ON final_submissions BEGIN SELECT RAISE(ABORT,'final_answers_immutable'); END;
-- Reject in-flight writes from a season that has already been archived/reset.
CREATE TRIGGER ledger_closed_season BEFORE INSERT ON transactions
WHEN EXISTS(SELECT 1 FROM seasons s WHERE s.closed_at IS NOT NULL AND NEW.created_at>=s.starts_at AND NEW.created_at<s.ends_at)
BEGIN SELECT RAISE(ABORT,'season_closed'); END;
CREATE TRIGGER predictions_season_insert BEFORE INSERT ON predictions
WHEN EXISTS(SELECT 1 FROM seasons s JOIN matches m ON m.id=NEW.match_id WHERE NEW.created_at>=s.starts_at AND NEW.created_at<s.ends_at AND (s.closed_at IS NOT NULL OR m.start_time>=s.ends_at))
BEGIN SELECT RAISE(ABORT,'match_closed'); END;
