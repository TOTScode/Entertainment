-- New default and unstarted queued quizzes only. Preserve all started timers/answers/history.
INSERT INTO api_state(key,value,updated_at) VALUES('quiz_settings','{"every_days":1,"time_limit":20,"attempts":1}',unixepoch())
ON CONFLICT(key) DO UPDATE SET value=json_set(api_state.value,'$.time_limit',20),updated_at=excluded.updated_at;
UPDATE quizzes SET time_limit=20 WHERE starts_at IS NULL OR starts_at>unixepoch();
