// Источники данных для прогнозов.
// OddsPapi: матчи и коэффициенты всех шести турниров, результаты ЛЕ и ЛК. Бесплатно 250 запросов в месяц.
// football-data.org: результаты АПЛ, Бундеслиги, Ла Лиги и ЛЧ. Бесплатно, 10 запросов в минуту.

export const TOURNAMENTS = [
  { code: "PL", name: "АПЛ", op: 17, fd: "PL" },
  { code: "BL1", name: "Бундеслига", op: 35, fd: "BL1" },
  { code: "PD", name: "Ла Лига", op: 8, fd: "PD" },
  { code: "CL", name: "Лига чемпионов", op: 7, fd: "CL" },
  { code: "EL", name: "Лига Европы", op: 679 },
  { code: "ECL", name: "Лига конференций", op: 34480 },
];

export const BOOKMAKER = "pinnacle"; // самая низкая маржа; бесплатный тариф — один букмекер на запрос

const OP_BASE = "https://api.oddspapi.io/v4";
const FD_BASE = "https://api.football-data.org/v4";

// Рынки OddsPapi: 101 — исход основного времени, 10336 — точный счёт основного времени.
// Названия исходов взяты из справочника /v4/markets (он большой, поэтому не запрашиваем его каждый раз).
const OUTCOMES_1X2 = { 101: "1", 102: "X", 103: "2" };
const OUTCOMES_SCORE = {
  10336: "0:0", 10337: "1:0", 10338: "2:0", 10339: "3:0", 10340: "4:0", 10341: "5:0", 10342: "6:0", 10343: "7:0",
  10344: "0:1", 10345: "1:1", 10346: "2:1", 10347: "3:1", 10348: "4:1", 10349: "5:1", 10350: "6:1", 10351: "7:1",
  10352: "0:2", 10353: "1:2", 10354: "2:2", 10355: "3:2", 10356: "4:2", 10357: "5:2", 10358: "6:2", 10359: "7:2",
  10360: "0:3", 10361: "1:3", 10362: "2:3", 10363: "3:3", 10364: "4:3", 10365: "5:3", 10366: "6:3", 10367: "7:3",
  10368: "0:4", 10369: "1:4", 10370: "2:4", 10371: "3:4", 10372: "4:4", 10373: "5:4", 10374: "6:4", 10375: "7:4",
  10376: "0:5", 10377: "1:5", 10378: "2:5", 10379: "3:5", 10380: "4:5", 10381: "5:5", 10382: "6:5", 10383: "7:5",
  10384: "0:6", 10385: "1:6", 10386: "2:6", 10387: "3:6", 10388: "4:6", 10389: "5:6", 10390: "6:6", 10391: "7:6",
  10392: "0:7", 10393: "1:7", 10394: "2:7", 10395: "3:7", 10396: "4:7", 10397: "5:7", 10398: "6:7", 10399: "7:7",
};
const MARKETS = { 101: ["1x2", OUTCOMES_1X2], 10336: ["score", OUTCOMES_SCORE] };

const ts = (iso) => Math.floor(Date.parse(iso) / 1000);

async function getJson(url, headers = {}) {
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`${new URL(url).host} ${new URL(url).pathname}: HTTP ${res.status}`);
  return res.json();
}

// Статус матча OddsPapi по названию: числовые коды в документации описаны по-разному
export function opStatus(fixture) {
  const name = String(fixture.statusName || "");
  if (/postpon|delay|interrupt|suspend/i.test(name)) return "postponed";
  if (/cancel|abandon/i.test(name)) return "cancelled";
  if (/finish|ended|after/i.test(name)) return "finished";
  if (/play|live|half|progress/i.test(name)) return "live";
  return "scheduled";
}

// Коэффициенты одного матча из ответа OddsPapi: [{ market, outcome, price }]
export function opOdds(fixture) {
  const book = fixture.bookmakerOdds?.[BOOKMAKER];
  if (!book || book.suspended || book.bookmakerIsActive === false) return [];
  const out = [];
  for (const [marketId, [market, names]] of Object.entries(MARKETS)) {
    const m = book.markets?.[marketId];
    if (!m || m.marketActive === false) continue;
    for (const [outcomeId, outcome] of Object.entries(m.outcomes || {})) {
      const label = names[outcomeId];
      const player = Object.values(outcome.players || {})[0];
      const price = Number(player?.price);
      if (!label || !player || player.active === false || !(price > 1)) continue;
      out.push({ market, outcome: label, price: Math.round(price * 100) / 100 });
    }
  }
  return out;
}

export function oddsPapi(apiKey) {
  const call = (path) => getJson(`${OP_BASE}/${path}${path.includes("?") ? "&" : "?"}apiKey=${encodeURIComponent(apiKey)}`);
  return {
    // Не расходует лимит
    async quota() {
      const a = await call("account");
      const subs = a.subscriptions || [];
      const cur = subs.find((s) => s.subscription_id === a.current_subscription_id) || subs[0] || {};
      return { limit: Number(cur.request_limit) || 0, used: Number(cur.request_count) || 0 };
    },
    // Все ближайшие матчи турнира с коэффициентами — один запрос
    async odds(tournamentId) {
      const body = await call(`odds-by-tournaments?tournamentIds=${tournamentId}&bookmaker=${BOOKMAKER}&verbosity=3`);
      const list = Array.isArray(body) ? body : body?.fixtures || [];
      return list.map((f) => ({
        op_id: f.fixtureId,
        home: f.participant1Name,
        away: f.participant2Name,
        start_time: ts(f.startTime),
        status: opStatus(f),
        odds: opOdds(f),
      }));
    },
    async fixtures(tournamentId, from, to) {
      const iso = (t) => new Date(t * 1000).toISOString().slice(0, 10);
      const body = await call(`fixtures?tournamentId=${tournamentId}&from=${iso(from)}&to=${iso(to)}`);
      return (Array.isArray(body) ? body : []).map((f) => ({
        op_id: f.fixtureId,
        start_time: ts(f.startTime),
        status: opStatus(f),
      }));
    },
    // Счёт основного времени (период fulltime) или null, если его ещё нет
    async regularScore(fixtureId) {
      const body = await call(`scores?fixtureId=${encodeURIComponent(fixtureId)}`);
      const p = body?.scores?.periods?.fulltime;
      if (!p || p.participant1Score == null || p.participant2Score == null) return null;
      return [Number(p.participant1Score), Number(p.participant2Score)];
    },
  };
}

// Результат football-data.org: статус и счёт основного времени (без дополнительного времени и пенальти)
export function fdMatch(m) {
  const s = m.score || {};
  let score = null;
  if (m.status === "FINISHED") {
    const regular = s.duration === "REGULAR" || !s.duration ? s.fullTime : s.regularTime;
    if (regular && regular.home != null && regular.away != null) score = [regular.home, regular.away];
  }
  const status = {
    FINISHED: "finished",
    CANCELLED: "cancelled",
    AWARDED: "cancelled",
    POSTPONED: "postponed",
    SUSPENDED: "postponed",
    IN_PLAY: "live",
    PAUSED: "live",
  }[m.status] || "scheduled";
  return {
    fd_id: m.id,
    home: [m.homeTeam?.name, m.homeTeam?.shortName].filter(Boolean),
    away: [m.awayTeam?.name, m.awayTeam?.shortName].filter(Boolean),
    start_time: ts(m.utcDate),
    status,
    score,
  };
}

export function footballData(token) {
  return {
    async matches(code, from, to) {
      const iso = (t) => new Date(t * 1000).toISOString().slice(0, 10);
      const body = await getJson(`${FD_BASE}/competitions/${code}/matches?dateFrom=${iso(from)}&dateTo=${iso(to)}`, {
        "X-Auth-Token": token,
      });
      return (body.matches || []).map(fdMatch);
    },
  };
}

// Сопоставление команд из разных источников: «Bayer 04 Leverkusen» и «Bayer Leverkusen» — одна команда
const NOISE = new Set(["fc", "cf", "afc", "sc", "ac", "as", "ssc", "cd", "rcd", "ud", "sd", "sv", "vfl", "vfb", "tsg", "fsv", "bv", "bsc", "de", "club", "calcio", "1", "04", "05", "1899", "1846", "1848", "1909", "1910", "fk", "nk", "sk", "if"]);
export function teamTokens(name) {
  return new Set(
    String(name)
      .normalize("NFD")
      .replace(/\p{M}/gu, "")
      .toLowerCase()
      .replace(/[^a-z0-9 ]+/g, " ")
      .split(/\s+/)
      .filter((t) => t && !NOISE.has(t)),
  );
}

function similarity(names, other) {
  const b = teamTokens(other);
  let best = 0;
  for (const name of names) {
    const a = teamTokens(name);
    const common = [...a].filter((t) => b.has(t)).length;
    if (common) best = Math.max(best, common / Math.min(a.size, b.size));
  }
  return best;
}

// Находит в списке football-data.org матч, соответствующий нашему (из OddsPapi)
export function findFdMatch(match, candidates) {
  if (match.fd_id) return candidates.find((c) => c.fd_id === match.fd_id) || null;
  let best = null;
  let bestScore = 0;
  for (const c of candidates) {
    if (Math.abs(c.start_time - match.start_time) > 3 * 3600 && c.status !== "postponed") continue;
    const score = similarity(c.home, match.home) + similarity(c.away, match.away);
    if (score > bestScore) {
      best = c;
      bestScore = score;
    }
  }
  // Обе команды должны совпасть хотя бы наполовину
  return bestScore >= 1 ? best : null;
}
