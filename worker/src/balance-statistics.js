// Lifetime profile totals: reserved stakes and returned principal are not flows.
// Read current settlements so result reversals/corrections cannot double-count wins.
export function balanceStatisticsColumns(userIdSql) {
  const ordinary = "type NOT IN ('bet','refund','payout','payout_reversal','season_opening','quiz_reward_reversal')";
  return `
    MAX(0, COALESCE((SELECT SUM(CASE WHEN (${ordinary} AND amount>0) OR type='quiz_reward_reversal' THEN amount ELSE 0 END) FROM transactions WHERE user_id=${userIdSql}),0))
      + COALESCE((SELECT SUM(MAX(0,payout-stake)) FROM predictions WHERE user_id=${userIdSql} AND status='won'),0) AS earned,
    COALESCE((SELECT SUM(CASE WHEN ${ordinary} AND amount<0 THEN -amount ELSE 0 END) FROM transactions WHERE user_id=${userIdSql}),0)
      + COALESCE((SELECT SUM(stake) FROM predictions WHERE user_id=${userIdSql} AND status='lost'),0) AS spent`;
}
