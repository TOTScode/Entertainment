// Суммы BIST в базе хранятся целым числом в 1/10000 BIST, чтобы дробные выплаты считались без ошибок округления.
// Наружу (в API) отдаются обычные числа BIST.

export const UNIT = 10000;

export const toBist = (units) => (units ?? 0) / UNIT;
export const toUnits = (bist) => Math.round(Number(bist) * UNIT);
