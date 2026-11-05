-- Рейтинг теперь по викторинам и угаданным исходам, а не по BIST: старые снимки мест не сравнимы с новыми.
DELETE FROM rank_snapshots;
CREATE INDEX quiz_answers_user ON quiz_answers(user_id, correct);
