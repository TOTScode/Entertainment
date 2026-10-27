// Ручная проверка бесплатных API для прогнозов (этап 4). Запускается из Actions: Probe football APIs.
// Печатает только сводку: покрытие турниров, лимиты, пример данных. Ключи в вывод не попадают.

const FD = process.env.FOOTBALL_DATA_TOKEN?.trim();
const OP = process.env.ODDSPAPI_KEY?.trim();
const day = 86400000;
const iso = (t) => new Date(t).toISOString().slice(0, 10);
const now = Date.now();
const hide = (s) => String(s).replaceAll(FD || "\0", "***").replaceAll(OP || "\0", "***");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const short = (v, n = 600) => hide(JSON.stringify(v)).slice(0, n);

async function get(url, headers = {}) {
  const res = await fetch(url, { headers });
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, body, headers: res.headers };
}

async function footballData() {
  console.log("\n===== football-data.org =====");
  if (!FD) return console.log("FOOTBALL_DATA_TOKEN не задан");
  for (const code of ["PL", "BL1", "PD", "CL", "EL", "ECL"]) {
    const r = await get(
      `https://api.football-data.org/v4/competitions/${code}/matches?dateFrom=${iso(now - 9 * day)}&dateTo=${iso(now + 14 * day)}`,
      { "X-Auth-Token": FD },
    );
    if (r.status !== 200) {
      console.log(`${code}: HTTP ${r.status} ${short(r.body, 200)}`);
    } else {
      const m = r.body.matches || [];
      const statuses = {};
      for (const x of m) statuses[x.status] = (statuses[x.status] || 0) + 1;
      const done = m.find((x) => x.status === "FINISHED");
      const next = m.find((x) => x.status === "TIMED" || x.status === "SCHEDULED");
      console.log(`${code}: ${r.body.competition?.name}, матчей ${m.length}, статусы ${JSON.stringify(statuses)}`);
      if (next) console.log(`  ближайший: ${next.utcDate} ${next.homeTeam?.name} — ${next.awayTeam?.name}`);
      if (done) console.log(`  сыгран: ${done.homeTeam?.name} — ${done.awayTeam?.name}, score=${short(done.score, 400)}`);
    }
    await sleep(6500); // 10 запросов в минуту
  }
}

async function oddsPapi() {
  console.log("\n===== OddsPapi =====");
  if (!OP) return console.log("ODDSPAPI_KEY не задан");
  let base = null;
  for (const host of ["https://api.oddspapi.io", "https://api.oddspapi.io/api"]) {
    const r = await get(`${host}/v4/account?apiKey=${OP}`);
    console.log(`account via ${host}: HTTP ${r.status}`);
    if (r.status === 200) {
      base = host;
      const subs = r.body.subscriptions || [];
      const cur = subs.find((s) => s.subscription_id === r.body.current_subscription_id) || subs[0] || {};
      console.log(`  тариф: price=${cur.price} ${cur.currency}, лимит ${cur.request_limit}, использовано ${cur.request_count}, rate_limit ${cur.rate_limit}`);
      console.log(`  виды спорта: ${JSON.stringify(cur.sport_ids)}, букмекеров: ${Object.keys(cur.bookmakers || {}).length}`);
      console.log(`  букмекеры: ${Object.keys(cur.bookmakers || {}).slice(0, 40).join(", ")}`);
      break;
    }
    console.log(`  ${short(r.body, 300)}`);
    await sleep(1100);
  }
  if (!base) return;
  const call = async (path) => { await sleep(2100); return get(`${base}/v4/${path}${path.includes("?") ? "&" : "?"}apiKey=${OP}`); };

  // Турниры футбола
  const t = await call("tournaments?sportId=10");
  console.log(`\ntournaments: HTTP ${t.status}`);
  const want = [/premier league/i, /bundesliga/i, /laliga|la liga/i, /champions league/i, /europa league/i, /conference league/i];
  const list = Array.isArray(t.body) ? t.body : [];
  for (const x of list.filter((x) => want.some((re) => re.test(x.tournamentName || "")) && /england|germany|spain|international|europe/i.test(`${x.categoryName} ${x.categorySlug}`))) {
    console.log(`  ${x.tournamentId}: ${x.tournamentName} (${x.categoryName}) upcoming=${x.upcomingFixtures} future=${x.futureFixtures}`);
  }
  if (!list.length) console.log(`  ${short(t.body)}`);

  // Матчи Лиги Европы за 10 дней назад и вперёд
  const f = await call(`fixtures?tournamentId=679&from=${iso(now - 9 * day)}&to=${iso(now + 9 * day)}`);
  console.log(`\nfixtures ЛЕ: HTTP ${f.status}`);
  const fx = Array.isArray(f.body) ? f.body : [];
  const byStatus = {};
  for (const x of fx) byStatus[x.statusName] = (byStatus[x.statusName] || 0) + 1;
  console.log(`  матчей ${fx.length}, статусы ${JSON.stringify(byStatus)}`);
  if (fx[0]) console.log(`  поля: ${Object.keys(fx[0]).join(", ")}`);
  const ended = fx.find((x) => x.statusId === 2);
  if (!fx.length) console.log(`  ${short(f.body)}`);

  // Счёт сыгранного матча ЛЕ
  if (ended) {
    const s = await call(`scores?fixtureId=${ended.fixtureId}`);
    console.log(`\nscores (${ended.participant1Name} — ${ended.participant2Name}): HTTP ${s.status} ${short(s.body, 800)}`);
  }

  // Коэффициенты АПЛ одним запросом
  const o = await call("odds-by-tournaments?tournamentIds=17&bookmakers=pinnacle,bet365");
  console.log(`\nodds-by-tournaments АПЛ: HTTP ${o.status}`);
  const fixtures = Array.isArray(o.body) ? o.body : o.body?.fixtures || [];
  console.log(`  матчей с коэффициентами: ${fixtures.length}`);
  const first = fixtures[0];
  if (first) {
    for (const [bk, b] of Object.entries(first.bookmakerOdds || {})) {
      const markets = Object.keys(b.markets || {});
      console.log(`  ${bk}: рынков ${markets.length}; 1X2 (101): ${markets.includes("101")}; точный счёт (10336): ${markets.includes("10336")}`);
      for (const id of ["101", "10336"]) {
        const m = b.markets?.[id];
        if (!m) continue;
        const prices = Object.entries(m.outcomes || {}).slice(0, 6).map(([oid, out]) => `${oid}=${Object.values(out.players || {})[0]?.price}`);
        console.log(`    рынок ${id}: ${prices.join(" ")}`);
      }
    }
  } else {
    console.log(`  ${short(o.body)}`);
  }

  const a = await call("account");
  const cur = (a.body.subscriptions || [])[0] || {};
  console.log(`\nпосле проверки использовано запросов: ${cur.request_count} из ${cur.request_limit}`);
}

await footballData();
await oddsPapi();
