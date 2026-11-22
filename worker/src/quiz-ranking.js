// Rating combines completed quizzes and question accuracy. Never uses BIST or forecasts.
const fraction = (r) => ({ n: (r.quizzes || 0) * (r.quiz_correct || 0), d: r.quiz_answers || 1 });
const compareRating = (a, b) => {
  const x = fraction(a),
    y = fraction(b);
  return y.n * x.d - x.n * y.d;
};
export function rankParticipants(rows) {
  const ordered = [...rows].sort(
    (a, b) => compareRating(a, b) || a.name.localeCompare(b.name, "ru") || a.id - b.id,
  );
  let rank = 0;
  return ordered.map((r, i) => {
    if (!i || compareRating(r, ordered[i - 1]) !== 0) rank = i + 1;
    const f = fraction(r);
    return { ...r, rank, quiz_rating: f.n / f.d };
  });
}
