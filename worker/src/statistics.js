// One completed attempt per user/quiz. Repeated answer submissions do not inflate counts.
export async function participantStats(db, { from = 0, to = Math.floor(Date.now() / 1000) + 1 } = {}) {
  const [questions, predictions] = await db.batch([
    db
      .prepare(
        `SELECT a.user_id,z.id AS quiz_id,
      COALESCE(json_extract(v.snapshot,'$.correct'),a.correct) AS correct,
      COALESCE(json_extract(v.snapshot,'$.attempts'),a.attempts) AS attempts,a.opened_at,
      CASE WHEN v.id IS NOT NULL THEN v.created_at ELSE a.answered_at END AS answered_at,
      z.ends_at,z.attempts_limit,z.time_limit,
      (SELECT COUNT(*) FROM quiz_questions q2 WHERE q2.quiz_id=z.id AND (q2.voided_at IS NULL OR q2.voided_at>=?2)) AS question_count
      FROM quiz_answers a JOIN quiz_questions q ON q.id=a.question_id JOIN quizzes z ON z.id=q.quiz_id
      LEFT JOIN content_versions v ON v.id=(SELECT v2.id FROM content_versions v2 WHERE v2.kind='answer' AND v2.target_id=a.question_id AND v2.actor_id=a.user_id AND v2.created_at<?2 ORDER BY v2.created_at DESC,v2.id DESC LIMIT 1)
      WHERE a.opened_at<?2 AND (q.voided_at IS NULL OR q.voided_at>=?2) AND z.starts_at>=?1 AND z.starts_at<?2`,
      )
      .bind(from, to),
    db
      .prepare(
        `SELECT user_id,COUNT(*) AS n,SUM(status='won') AS correct FROM predictions
      WHERE is_admin_test=0 AND status IN ('won','lost') AND settled_at>=?1 AND settled_at<?2 GROUP BY user_id`,
      )
      .bind(from, to),
  ]);
  const stats = new Map();
  const get = (id) => {
    if (!stats.has(id))
      stats.set(id, {
        quizzes: 0,
        quiz_answers: 0,
        quiz_correct: 0,
        quiz_percent: null,
        predictions: 0,
        prediction_correct: 0,
        prediction_percent: null,
      });
    return stats.get(id);
  };
  const groups = new Map();
  for (const a of questions.results) {
    const completed =
      Boolean(a.correct && a.answered_at < to) ||
      a.attempts >= (a.attempts_limit ?? 1) ||
      a.ends_at < to ||
      ((a.time_limit ?? 60) > 0 && a.opened_at + (a.time_limit ?? 60) + 5 < to);
    if (!completed) continue;
    const s = get(a.user_id);
    s.quiz_answers++;
    if (a.correct && a.answered_at < to) s.quiz_correct++;
    const key = `${a.user_id}:${a.quiz_id}`;
    const g = groups.get(key) || { user: a.user_id, n: 0, total: a.question_count };
    g.n++;
    groups.set(key, g);
  }
  for (const g of groups.values()) if (g.total > 0 && g.n === g.total) get(g.user).quizzes++;
  for (const p of predictions.results)
    Object.assign(get(p.user_id), {
      predictions: p.n,
      prediction_correct: p.correct,
      prediction_percent: p.n ? Math.round((p.correct * 10000) / p.n) / 100 : null,
    });
  for (const s of stats.values())
    s.quiz_percent = s.quiz_answers ? Math.round((s.quiz_correct * 10000) / s.quiz_answers) / 100 : null;
  return stats;
}
export const emptyStats = () => ({
  quizzes: 0,
  quiz_answers: 0,
  quiz_correct: 0,
  quiz_percent: null,
  predictions: 0,
  prediction_correct: 0,
  prediction_percent: null,
});
