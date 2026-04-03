var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// src/index.js
var DISCORD_INTERACTION_TYPE = {
  PING: 1,
  APPLICATION_COMMAND: 2
};
var DISCORD_RESPONSE_TYPE = {
  PONG: 1,
  CHANNEL_MESSAGE_WITH_SOURCE: 4
};
var EPHEMERAL_FLAG = 1 << 6;
var THREE_DAYS_MS = 3 * 24 * 60 * 60 * 1e3;
var OTOGE_DB_SONG_URLS = [
  "https://otoge-db.net/maimai/data/maimai_songs.json",
  "https://raw.githubusercontent.com/zvuc/otoge-db/master/maimai/data/maimai_songs.json"
];
var SONG_DIFFICULTY_FIELD_MAP = [
  { field: "lev_bas", chartSet: "STD", difficulty: "BASIC" },
  { field: "lev_adv", chartSet: "STD", difficulty: "ADVANCED" },
  { field: "lev_exp", chartSet: "STD", difficulty: "EXPERT" },
  { field: "lev_mas", chartSet: "STD", difficulty: "MASTER" },
  { field: "lev_remas", chartSet: "STD", difficulty: "Re:MASTER" },
  { field: "dx_lev_bas", chartSet: "DX", difficulty: "BASIC" },
  { field: "dx_lev_adv", chartSet: "DX", difficulty: "ADVANCED" },
  { field: "dx_lev_exp", chartSet: "DX", difficulty: "EXPERT" },
  { field: "dx_lev_mas", chartSet: "DX", difficulty: "MASTER" },
  { field: "dx_lev_remas", chartSet: "DX", difficulty: "Re:MASTER" },
  { field: "lev_utage", chartSet: "UTAGE", difficulty: "UTAGE" }
];
var ACHIEVEMENT_POINTS = {
  SSS: 0.5,
  "SSS+": 1,
  FC: 0.5,
  "FC+": 1,
  AP: 2.5,
  "AP+": 4,
  "\u661F5": 2.5
};
var OPTION_POINTS = {
  \u660E\u308B\u3044\u30D0\u30FC: 1.5,
  "\u30B9\u30E9\u30A4\u30C9+1": 0.5,
  \u5168\u53CD\u8EE2: 0.5
};
var DIFFICULTY_MULTIPLIER = {
  "14+": 1.3,
  "14": 1,
  "13+": 0.7
};
var index_default = {
  async fetch(request, env) {
    if (request.method !== "POST") {
      return jsonResponse({ error: "Method Not Allowed" }, 405);
    }
    const body = await request.text();
    const signature = request.headers.get("x-signature-ed25519");
    const timestamp = request.headers.get("x-signature-timestamp");
    const isValid = await verifyDiscordSignature(body, signature, timestamp, env.DISCORD_PUBLIC_KEY);
    if (!isValid) {
      return jsonResponse({ error: "Invalid request signature" }, 401);
    }
    const interaction = JSON.parse(body);
    if (interaction.type === DISCORD_INTERACTION_TYPE.PING) {
      return jsonResponse({ type: DISCORD_RESPONSE_TYPE.PONG });
    }
    if (interaction.type !== DISCORD_INTERACTION_TYPE.APPLICATION_COMMAND) {
      return interactionResponse("Unsupported interaction type", true);
    }
    await ensureUsersTableColumns(env.DB);
    await ensureSongTables(env.DB);
    try {
      return await routeCommand(interaction, env);
    } catch (error) {
      console.error(error);
      return interactionResponse("\u5185\u90E8\u304C\u58CA\u308C\u3066\u308B\u304B\u3082...\u308A\u3080\u306E\u3093\u306B\u9023\u7D61\u304A\u9858\u3044\uFF5E", true);
    }
  }
};
async function routeCommand(interaction, env) {
  const command = interaction.data?.name;
  const userId = interaction.member?.user?.id ?? interaction.user?.id;
  const userName = getInteractionDisplayName(interaction, userId);
  await ensureUser(userId, env.DB, userName);
  switch (command) {
    case "pt":
      return handlePoint(interaction, userId, env);
    case "submit":
      return handleSubmit(interaction, userId, env);
    case "battle":
      return handleBattle(interaction, userId, env);
    case "startbattle":
      return handleStartBattle(interaction, userId, env);
    case "result":
      return handleResult(interaction, userId, env);
    case "approve":
      return handleApprove(interaction, userId, env);
    case "reject":
      return handleReject(interaction, userId, env);
    case "battlereject":
      return handleRejectBattle(interaction, userId, env);
    case "ranking":
      return handleRanking(env);
    case "add":
      return handleAdd(interaction, userId, env);
    case "updatesongs":
      return handleUpdateSongs(interaction, env);
    case "omikuzi":
      return handleOmikuzi(interaction, env);
    default:
      return interactionResponse(`\u672A\u5BFE\u5FDC\u30B3\u30DE\u30F3\u30C9: ${command}`, true);
  }
}
__name(routeCommand, "routeCommand");
async function handlePoint(interaction, userId, env) {
  await ensureUser(userId, env.DB, getInteractionDisplayName(interaction, userId));
  const row = await env.DB.prepare("SELECT point FROM users WHERE user_id = ?").bind(userId).first();
  const displayName = getInteractionDisplayName(interaction, userId);
  return interactionResponse(`${displayName} \u306E\u73FE\u5728\u306E\u30DD\u30A4\u30F3\u30C8\u306F... **${formatPoint(row?.point ?? 0)}**pt\u3060\u3088!`);
}
__name(handlePoint, "handlePoint");
async function handleSubmit(interaction, userId, env) {
  await ensureUser(userId, env.DB);
  const subcommand = interaction.data?.options?.[0];
  if (!subcommand || subcommand.name !== "score") {
    return interactionResponse("/submit score \u306E\u307F\u5BFE\u5FDC\u3057\u3066\u308B\u3088\u3002", true);
  }
  const difficulty = getStringOption(subcommand.options, "difficulty");
  const achievements = getSelectedAchievements(subcommand.options);
  const options = getArrayOption(subcommand.options, "options");
  const multiplied = getBooleanOption(subcommand.options, "multiplied");
  if (!DIFFICULTY_MULTIPLIER[difficulty]) {
    return interactionResponse("difficulty \u306F 14+ / 14 / 13+ \u3060\u3051\u3060\u3088\uFF01", true);
  }
  const weekId = getCurrentWeekId();
  const duplicate = await env.DB.prepare(
    "SELECT id FROM score_submissions WHERE user_id = ? AND difficulty = ? AND week_id = ?"
  ).bind(userId, difficulty, weekId).first();
  if (duplicate) {
    return interactionResponse("\u3059\u3067\u306B\u7533\u8ACB\u6E08\u307F\u3060\u3088\uFF5E\uFF01\u305A\u308B\u3057\u306A\u3044\u3067\u306D", true);
  }
  const score = calculateScorePoint({ difficulty, achievements, options, multiplied });
  const requestId = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO requests (id, type, user_id, data, calculated_point, status, created_at)
     VALUES (?, 'score', ?, ?, ?, 'pending', ?)`
  ).bind(
    requestId,
    userId,
    JSON.stringify({ difficulty, achievements, options, multiplied, weekId }),
    score,
    Date.now()
  ).run();
  await logAction(env.DB, userId, "submit_score_request", score);
  return interactionResponse(
    `\u541B\u306E\u4ECA\u56DE\u9811\u5F35\u3063\u305F\u30B9\u30B3\u30A2\u3092\u7533\u8ACB\u3057\u305F\u3088! requestId: ${requestId}
\u541B\u306E\u4ECA\u56DE\u306E\u30DD\u30A4\u30F3\u30C8\u306F...**${formatPoint(score)}**pt\uFF08\u627F\u8A8D\u5F85\u3061\uFF09`
  );
}
__name(handleSubmit, "handleSubmit");
async function handleBattle(interaction, userId, env) {
  await ensureUser(userId, env.DB);
  const targetId = getUserOption(interaction.data?.options, "user");
  if (!targetId || targetId === userId) {
    return interactionResponse("\u541B\u306B\u3075\u3055\u308F\u3057\u3044\u76F8\u624B\u3092\u3061\u3083\u3093\u3068\u9078\u3093\u3067\u306D\uFF1F", true);
  }
  await ensureUser(targetId, env.DB);
  const existingBattle = await env.DB.prepare(
    `SELECT * FROM battles
     WHERE status IN ('pending', 'active', 'awaiting_approval')
       AND (player_a = ? OR player_b = ?)
     ORDER BY created_at DESC LIMIT 1`
  ).bind(userId, userId).first();
  if (existingBattle) {
    return interactionResponse(
      `\u307E\u3060\u9032\u884C\u4E2D\u306E\u5BFE\u6226\u304C\u3042\u308B\u3088\uFF01battleId: ${existingBattle.id} \u3092\u7D42\u3048\u3066\u304B\u3089\u65B0\u3057\u3044\u5BFE\u6226\u3092\u4F5C\u3063\u3066\u306D\u266A`,
      true
    );
  }
  const targetBattle = await env.DB.prepare(
    `SELECT * FROM battles
     WHERE status IN ('pending', 'active', 'awaiting_approval')
       AND (player_a = ? OR player_b = ?)
     ORDER BY created_at DESC LIMIT 1`
  ).bind(targetId, targetId).first();
  if (targetBattle) {
    return interactionResponse(
      `\u9078\u3093\u3060\u76F8\u624B <@${targetId}> \u306F\u307E\u3060\u9032\u884C\u4E2D\u306E\u5BFE\u6226\u304C\u3042\u308B\u3088\uFF01\u5225\u306E\u76F8\u624B\u3092\u9078\u3093\u3067\u306D\u266A`,
      true
    );
  }
  const now = Date.now();
  const battleId = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO battles (id, player_a, player_b, bet_a, bet_b, status, thread_id, result, created_at)
     VALUES (?, ?, ?, NULL, NULL, 'pending', '', '{}', ?)`
  ).bind(battleId, userId, targetId, now).run();
  await logAction(env.DB, userId, "battle_create", 0);
  return interactionResponse(`<@${targetId}>\u3068\u306E\u5BFE\u6226\u3092\u4F5C\u6210\u3057\u305F\u3088\uFF01\u9811\u5F35\u308D\u3046\uFF01 battleId: ${battleId}`);
}
__name(handleBattle, "handleBattle");
async function handleStartBattle(interaction, userId, env) {
  const amount = getNumberOption(interaction.data?.options, "amount");
  if (!amount || amount <= 0) {
    return interactionResponse("amount \u306F 0 \u3088\u308A\u5927\u304D\u3044\u5024\u3092\u6307\u5B9A\u3057\u3066\u306D\uFF01", true);
  }
  await ensureUser(userId, env.DB);
  const now = Date.now();
  const me = await env.DB.prepare("SELECT point, last_battle_at FROM users WHERE user_id = ?").bind(userId).first();
  if ((me?.point ?? 0) < amount) {
    return interactionResponse("\u305D\u3093\u306A\u306B\u30DD\u30A4\u30F3\u30C8\u6301\u3063\u3066\u306A\u3044\u3088\uFF5E\uFF01", true);
  }
  const battle = await env.DB.prepare(
    `SELECT * FROM battles
     WHERE status = 'pending' AND (player_a = ? OR player_b = ?)
     ORDER BY created_at DESC LIMIT 1`
  ).bind(userId, userId).first();
  if (!battle) {
    return interactionResponse("\u307E\u3060\u5BFE\u6226\u76F8\u624B\u898B\u3064\u3051\u3066\u306A\u3044\u304B\u3082\uFF1F/battle\u3067\u5BFE\u6226\u76F8\u624B\u3092\u9078\u3093\u3067\u306D\u266A", true);
  }
  const isA = battle.player_a === userId;
  const betA = isA ? amount : battle.bet_a;
  const betB = isA ? battle.bet_b : amount;
  const nextStatus = betA != null && betB != null ? "active" : "pending";
  await env.DB.prepare("UPDATE battles SET bet_a = ?, bet_b = ?, status = ? WHERE id = ?").bind(betA, betB, nextStatus, battle.id).run();
  await logAction(env.DB, userId, "battle_bet", amount);
  if (nextStatus === "active") {
    const players = [battle.player_a, battle.player_b];
    const bets = [betA, betB];
    for (let i = 0; i < 2; i++) {
      await env.DB.prepare(
        "UPDATE users SET point = point - ? WHERE user_id = ?"
      ).bind(bets[i], players[i]).run();
    }
  }
  return interactionResponse(
    nextStatus === "active" ? `\u30D9\u30C3\u30C8\u78BA\u5B9A\u3059\u308B\u306D\u266A  \u4E8C\u4EBA\u306E\u639B\u3051\u305F\u91D1\u984D\u306F...<@${battle.player_a}>:${betA}\u3068<@${battle.player_b}>:${betB}\u3060\u3088\uFF01\u5408\u8A08\u306F${betA + betB}` : `\u30D9\u30C3\u30C8\u53D7\u4ED8\u3059\u308B\u306D\u266A \u76F8\u624B\u306E\u5165\u529B\u5F85\u3061\u3060\u3088\uFF5E\uFF01`
  );
}
__name(handleStartBattle, "handleStartBattle");
async function handleResult(interaction, userId, env) {
  const result = getStringOption(interaction.data?.options, "result");
  if (!["win", "lose"].includes(result)) {
    return interactionResponse("result \u306F win \u307E\u305F\u306F lose \u3092\u6307\u5B9A\u3057\u3066\u306D\uFF01", true);
  }
  const battle = await env.DB.prepare(
    `SELECT * FROM battles
     WHERE status = 'active' AND (player_a = ? OR player_b = ?)
     ORDER BY created_at DESC LIMIT 1`
  ).bind(userId, userId).first();
  if (!battle) {
    return interactionResponse("\u307E\u3060\u8A66\u5408\u521D\u3081\u3066\u306A\u3044\u304B\u3082\uFF1F", true);
  }
  const currentResult = safeJsonParse(battle.result, {});
  currentResult[userId] = result;
  await env.DB.prepare("UPDATE battles SET result = ? WHERE id = ?").bind(JSON.stringify(currentResult), battle.id).run();
  const aResult = currentResult[battle.player_a];
  const bResult = currentResult[battle.player_b];
  if (!aResult || !bResult) {
    return interactionResponse("\u541B\u306E\u7D50\u679C\u306F\u8A18\u9332\u3057\u305F\u3088\uFF01\u76F8\u624B\u3092\u5F85\u3063\u3066\u306D\uFF01");
  }
  if (aResult === bResult) {
    return interactionResponse("\u3042\u308C\uFF1F\u7D50\u679C\u304C\u3042\u308F\u306A\u3044\u305E\uFF1F\u308A\u3080\u306E\u3093\u3092\u547C\u3093\u3067\uFF5E\u{1F4A6}", true);
  }
  const winner = aResult === "win" ? battle.player_a : battle.player_b;
  const loser = winner === battle.player_a ? battle.player_b : battle.player_a;
  const requestId = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO requests (id, type, user_id, data, calculated_point, status, created_at)
     VALUES (?, 'resolve', ?, ?, ?, 'pending', ?)`
  ).bind(
    requestId,
    // id
    winner,
    // user_id
    JSON.stringify({
      battleId: battle.id,
      winner,
      loser,
      betA: battle.bet_a,
      betB: battle.bet_b,
      insuranceUsed: false
    }),
    // data
    0,
    // calculated_point（バトルなので一旦0）
    Date.now()
    // created_at
  ).run();
  await env.DB.prepare(
    "UPDATE battles SET status = 'awaiting_approval' WHERE id = ?"
  ).bind(battle.id).run();
  return interactionResponse(
    `\u3088\u30FC\u3057\u7D50\u679C\u3092\u5165\u529B\u3067\u304D\u305F\u306D\u3002\u304A\u75B2\u308C\u69D8\uFF01 \u308A\u3080\u306E\u3093\u306B\u8A8D\u8A3C\u3057\u3066\u3082\u3089\u3063\u3066\u306D\u266A requestId: ${requestId}`
  );
}
__name(handleResult, "handleResult");
async function handleApprove(interaction, userId, env) {
  if (!isAdmin(interaction, env)) {
    return interactionResponse("\u3053\u306E\u30B3\u30DE\u30F3\u30C9\u306F\u904B\u55B6\u306E\u307F\u4F7F\u7528\u3067\u304D\u307E\u3059\u3002", true);
  }
  const requestId = getStringOption(interaction.data?.options, "requestid");
  if (!requestId) return interactionResponse("requestId \u304C\u5FC5\u8981\u3060\u3088", true);
  const req = await env.DB.prepare("SELECT * FROM requests WHERE id = ?").bind(requestId).first();
  if (!req) return interactionResponse("request\u304C\u898B\u3064\u304B\u3089\u306A\u3044\u3088", true);
  if (req.status !== "pending") return interactionResponse("\u65E2\u306B\u51E6\u7406\u6E08\u307F\u306Erequest\u3060\u3088\u3002", true);
  const data = safeJsonParse(req.data, {});
  if (req.type === "score") {
    await ensureUser(req.user_id, env.DB);
    await env.DB.prepare("UPDATE users SET point = point + ? WHERE user_id = ?").bind(req.calculated_point, req.user_id).run();
    await env.DB.prepare(
      "INSERT OR IGNORE INTO score_submissions (user_id, difficulty, week_id) VALUES (?, ?, ?)"
    ).bind(req.user_id, data.difficulty, data.weekId).run();
    await logAction(env.DB, req.user_id, "approve_score", req.calculated_point);
  } else if (req.type === "resolve") {
    const winner = data.winner;
    const loser = data.loser;
    const battle = await env.DB.prepare("SELECT player_a, player_b, bet_a, bet_b FROM battles WHERE id = ?").bind(data.battleId).first();
    if (!battle) return interactionResponse("\u95A2\u9023battle\u304C\u898B\u3064\u304B\u308A\u307E\u305B\u3093\u3002", true);
    const loserBet = Number(loser === battle.player_a ? battle.bet_a : battle.bet_b);
    const winnerBet = Number(winner === battle.player_a ? battle.bet_a : battle.bet_b);
    const gain = winnerBet + loserBet * 0.8;
    const loss = loserBet * 0.2;
    const loserNet = -loss;
    await ensureUser(winner, env.DB);
    await ensureUser(loser, env.DB);
    await env.DB.prepare("UPDATE users SET point = point + ?, last_battle_at = ? WHERE user_id = ?").bind(gain, Date.now(), winner).run();
    await env.DB.prepare(
      "UPDATE users SET point = point + ?, bonus_multiplier = bonus_multiplier + 0.1, last_battle_at = ? WHERE user_id = ?"
    ).bind(loss, Date.now(), loser).run();
    await env.DB.prepare("UPDATE battles SET status = 'resolved' WHERE id = ?").bind(data.battleId).run();
    await logAction(env.DB, winner, "approve_battle_win", gain);
    await logAction(env.DB, loser, "approve_battle_lose", loserNet);
  } else if (req.type === "exchange") {
    await ensureUser(req.user_id, env.DB);
    const cost = Number(data?.cost ?? 0);
    await env.DB.prepare("UPDATE users SET point = point - ? WHERE user_id = ?").bind(cost, req.user_id).run();
    await logAction(env.DB, req.user_id, "approve_exchange", -cost);
  } else {
    return interactionResponse(`\u672A\u77E5\u306E request type: ${req.type}`, true);
  }
  await env.DB.prepare("UPDATE requests SET status = 'approved' WHERE id = ?").bind(requestId).run();
  return interactionResponse(`request ${requestId} \u3092\u627F\u8A8D\u3057\u305F\u3088\u266A`);
}
__name(handleApprove, "handleApprove");
async function handleReject(interaction, userId, env) {
  if (!isAdmin(interaction, env)) {
    return interactionResponse("\u3053\u306E\u30B3\u30DE\u30F3\u30C9\u306F\u904B\u55B6\u306E\u307F\u4F7F\u7528\u3067\u304D\u307E\u3059\u3002", true);
  }
  const requestId = getStringOption(interaction.data?.options, "requestid");
  if (!requestId) return interactionResponse("requestId \u304C\u5FC5\u8981\u3067\u3059\u3002", true);
  const result = await env.DB.prepare("UPDATE requests SET status = 'rejected' WHERE id = ? AND status = 'pending'").bind(requestId).run();
  if ((result.meta?.changes ?? 0) === 0) {
    return interactionResponse("pending request \u304C\u898B\u3064\u304B\u3089\u306A\u3044\u3088\uFF5E", true);
  }
  return interactionResponse(`\u3054\u3081\u3093\u306D\u3002request ${requestId} \u3092\u5374\u4E0B\u3057\u305F\u3088\u3002`);
}
__name(handleReject, "handleReject");
async function handleRanking(env) {
  const rows = await env.DB.prepare("SELECT user_id, point, user_name FROM users ORDER BY point DESC LIMIT 10").all();
  const ranked = rows.results ?? [];
  const lines = await Promise.all(
    ranked.map(async (row, idx) => {
      const dbName = String(row.user_name ?? "").trim();
      const name = dbName || await fetchDiscordDisplayName(row.user_id, env);
      return `${idx + 1}. ${name} - ${formatPoint(row.point)}pt`;
    })
  );
  return interactionResponse(lines.join("\n") || "\u30E9\u30F3\u30AD\u30F3\u30B0\u30C7\u30FC\u30BF\u304C\u3042\u308A\u307E\u305B\u3093\u3002");
}
__name(handleRanking, "handleRanking");
async function handleAdd(interaction, userId, env) {
  if (!isAdmin(interaction, env)) {
    return interactionResponse("\u3053\u306E\u30B3\u30DE\u30F3\u30C9\u306F\u904B\u55B6\u306E\u307F\u4F7F\u7528\u3067\u304D\u307E\u3059\u3002", true);
  }
  const targetId = getUserOption(interaction.data?.options, "player");
  const delta = getNumberOption(interaction.data?.options, "point");
  if (!targetId) {
    return interactionResponse("player \u3092\u6307\u5B9A\u3057\u3066\u304F\u3060\u3055\u3044\u3002", true);
  }
  if (!Number.isFinite(delta) || delta === 0) {
    return interactionResponse("point \u306F 0 \u4EE5\u5916\u306E\u6570\u5024\u3092\u6307\u5B9A\u3057\u3066\u304F\u3060\u3055\u3044\u3002", true);
  }
  const targetResolved = interaction.data?.resolved?.users?.[targetId];
  const targetResolvedName = targetResolved?.global_name ?? targetResolved?.username ?? null;
  await ensureUser(targetId, env.DB, targetResolvedName);
  await env.DB.prepare("UPDATE users SET point = point + ? WHERE user_id = ?").bind(delta, targetId).run();
  const updated = await env.DB.prepare("SELECT point FROM users WHERE user_id = ?").bind(targetId).first();
  await logAction(env.DB, userId, "admin_add_point", delta);
  const targetUser = interaction.data?.resolved?.users?.[targetId];
  const targetName = targetUser?.global_name ?? targetUser?.username ?? targetId;
  return interactionResponse(
    `${targetName} \u306B ${formatPoint(delta)}pt \u3092\u53CD\u6620\u3057\u305F\u3088\uFF01\u73FE\u5728\u306E\u30DD\u30A4\u30F3\u30C8\u306F **${formatPoint(updated?.point ?? 0)}**pt:\u3060\u3088\uFF01`
  );
}
__name(handleAdd, "handleAdd");
async function handleUpdateSongs(interaction, env) {
  if (!isAdmin(interaction, env)) {
    return interactionResponse("\u3053\u306E\u30B3\u30DE\u30F3\u30C9\u306F\u904B\u55B6\u306E\u307F\u4F7F\u7528\u3067\u304D\u307E\u3059\u3002", true);
  }
  const songs = await fetchOtogeDbSongs();
  if (!songs.length) {
    return interactionResponse("\u66F2\u30C7\u30FC\u30BF\u3092\u53D6\u5F97\u3067\u304D\u307E\u305B\u3093\u3067\u3057\u305F\u3002", true);
  }
  const syncedAt = Date.now();
  const batchSize = 100;
  let chartCount = 0;
  let statements = [];
  for (const rawSong of songs) {
    const song = normalizeOtogeSong(rawSong);
    if (!song) continue;
    statements.push(
      env.DB.prepare(
        `INSERT INTO songs (song_id, title, artist, version, chart_type, synced_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(song_id) DO UPDATE SET
           title = excluded.title,
           artist = excluded.artist,
           version = excluded.version,
           chart_type = excluded.chart_type,
           synced_at = excluded.synced_at`
      ).bind(song.songId, song.title, song.artist, song.version, song.chartType, syncedAt)
    );
    for (const chart of song.charts) {
      chartCount += 1;
      statements.push(
        env.DB.prepare(
          `INSERT INTO song_charts (song_id, chart_set, difficulty, level, level_value, synced_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(song_id, chart_set, difficulty) DO UPDATE SET
             level = excluded.level,
             level_value = excluded.level_value,
             synced_at = excluded.synced_at`
        ).bind(song.songId, chart.chartSet, chart.difficulty, chart.level, chart.levelValue, syncedAt)
      );
    }
    if (statements.length >= batchSize) {
      await env.DB.batch(statements);
      statements = [];
    }
  }
  if (statements.length > 0) {
    await env.DB.batch(statements);
  }
  await env.DB.prepare("DELETE FROM song_charts WHERE synced_at <> ?").bind(syncedAt).run();
  await env.DB.prepare("DELETE FROM songs WHERE synced_at <> ?").bind(syncedAt).run();
  return interactionResponse(
    `\u66F2\u30C7\u30FC\u30BF\u3092\u66F4\u65B0\u3057\u307E\u3057\u305F\u3002
\u5BFE\u8C61\u66F2\u6570: ${songs.length} \u66F2
\u8B5C\u9762\u6570: ${chartCount} \u4EF6
\u66F4\u65B0\u5143: OTOGE DB`
  );
}
__name(handleUpdateSongs, "handleUpdateSongs");
async function handleOmikuzi(interaction, env) {
  const level = getNumberOption(interaction.data?.options, "difficulty");
  if (!Number.isInteger(level) || level < 1 || level > 15) {
    return interactionResponse("difficulty \u306F 1 \u304B\u3089 15 \u306E\u6574\u6570\u3067\u6307\u5B9A\u3057\u3066\u304F\u3060\u3055\u3044\u3002", true);
  }
  const song = await env.DB.prepare(
    `SELECT DISTINCT s.song_id, s.title, s.artist, s.version, s.chart_type
     FROM songs s
     INNER JOIN song_charts c ON c.song_id = s.song_id
     WHERE c.level_value = ? AND c.chart_set IN ('STD', 'DX')
     ORDER BY RANDOM()
     LIMIT 1`
  ).bind(level).first();
  if (!song) {
    return interactionResponse(
      `\u30EC\u30D9\u30EB ${level} \u306E\u66F2\u30C7\u30FC\u30BF\u304C\u3042\u308A\u307E\u305B\u3093\u3002\u5148\u306B /updatesongs \u3092\u5B9F\u884C\u3057\u3066\u304F\u3060\u3055\u3044\u3002`,
      true
    );
  }
  const matched = await env.DB.prepare(
    `SELECT chart_set, difficulty, level
     FROM song_charts
     WHERE song_id = ? AND level_value = ? AND chart_set IN ('STD', 'DX')
     ORDER BY CASE chart_set WHEN 'STD' THEN 0 WHEN 'DX' THEN 1 ELSE 2 END, difficulty`
  ).bind(song.song_id, level).all();
  const matchedCharts = (matched.results ?? []).map(
    (chart) => `${chart.chart_set} ${chart.difficulty} ${chart.level}`
  );
  return interactionResponse(
    [
      `\u30EC\u30D9\u30EB ${level} \u304A\u307F\u304F\u3058\u7D50\u679C`,
      `\u66F2\u540D: **${song.title}**`,
      `\u30A2\u30FC\u30C6\u30A3\u30B9\u30C8: ${song.artist}`,
      `\u30D0\u30FC\u30B8\u30E7\u30F3: ${song.version}`,
      `\u7A2E\u5225: ${song.chart_type}`,
      `\u8A72\u5F53\u8B5C\u9762: ${matchedCharts.join(" / ") || "\u306A\u3057"}`
    ].join("\n")
  );
}
__name(handleOmikuzi, "handleOmikuzi");
async function ensureUsersTableColumns(db) {
  try {
    await db.prepare("ALTER TABLE users ADD COLUMN user_name TEXT DEFAULT ''").run();
  } catch {
  }
}
__name(ensureUsersTableColumns, "ensureUsersTableColumns");
async function ensureSongTables(db) {
  await db.prepare(
    `CREATE TABLE IF NOT EXISTS songs (
      song_id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      artist TEXT NOT NULL,
      version TEXT NOT NULL,
      chart_type TEXT NOT NULL,
      synced_at INTEGER NOT NULL
    )`
  ).run();
  await db.prepare(
    `CREATE TABLE IF NOT EXISTS song_charts (
      song_id TEXT NOT NULL,
      chart_set TEXT NOT NULL,
      difficulty TEXT NOT NULL,
      level TEXT NOT NULL,
      level_value INTEGER,
      synced_at INTEGER NOT NULL,
      PRIMARY KEY (song_id, chart_set, difficulty)
    )`
  ).run();
}
__name(ensureSongTables, "ensureSongTables");
function getInteractionDisplayName(interaction, fallback = "") {
  return interaction.member?.nick ?? interaction.member?.user?.global_name ?? interaction.member?.user?.username ?? interaction.user?.global_name ?? interaction.user?.username ?? fallback;
}
__name(getInteractionDisplayName, "getInteractionDisplayName");
async function fetchDiscordDisplayName(userId, env) {
  const botToken = env.DISCORD_BOT_TOKEN;
  if (!botToken) return userId;
  try {
    const res = await fetch(`https://discord.com/api/v10/users/${userId}`, {
      headers: { Authorization: `Bot ${botToken}` }
    });
    if (!res.ok) return userId;
    const user = await res.json();
    return user.global_name || user.username || userId;
  } catch {
    return userId;
  }
}
__name(fetchDiscordDisplayName, "fetchDiscordDisplayName");
function calculateScorePoint({ difficulty, achievements, options }) {
  const normalized = normalizeAchievements(achievements);
  const hasAtLeastSSS = normalized.includes("SSS") || normalized.includes("SSS+");
  const basic = normalized.reduce((sum, key) => sum + (ACHIEVEMENT_POINTS[key] ?? 0), 0);
  const option = hasAtLeastSSS ? options.reduce((sum, key) => sum + (OPTION_POINTS[key] ?? 0), 0) : 0;
  return (basic + option) * DIFFICULTY_MULTIPLIER[difficulty];
}
__name(calculateScorePoint, "calculateScorePoint");
function normalizeAchievements(list) {
  const set = new Set(list);
  if (set.has("SSS+")) set.delete("SSS");
  return [...set];
}
__name(normalizeAchievements, "normalizeAchievements");
function getCurrentWeekId() {
  const now = /* @__PURE__ */ new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), 0, 1));
  const days = Math.floor((now - start) / 864e5);
  return Number(`${now.getUTCFullYear()}${String(Math.ceil((days + start.getUTCDay() + 1) / 7)).padStart(2, "0")}`);
}
__name(getCurrentWeekId, "getCurrentWeekId");
function getStringOption(options = [], name) {
  return options?.find((x) => x.name === name)?.value;
}
__name(getStringOption, "getStringOption");
function getNumberOption(options = [], name) {
  const v = options?.find((x) => x.name === name)?.value;
  return Number(v);
}
__name(getNumberOption, "getNumberOption");
function getBooleanOption(options = [], name) {
  return Boolean(options?.find((x) => x.name === name)?.value);
}
__name(getBooleanOption, "getBooleanOption");
function getSelectedAchievements(options = []) {
  const csv = getArrayOption(options, "achievements");
  if (csv.length > 0) return csv;
  const map = [
    ["sss", "SSS"],
    ["sss_plus", "SSS+"],
    ["fc", "FC"],
    ["fc_plus", "FC+"],
    ["ap", "AP"],
    ["ap_plus", "AP+"],
    ["star5", "\u661F5"]
  ];
  return map.filter(([key]) => getBooleanOption(options, key)).map(([, label]) => label);
}
__name(getSelectedAchievements, "getSelectedAchievements");
function getArrayOption(options = [], name) {
  const v = options?.find((x) => x.name === name)?.value;
  if (Array.isArray(v)) return v;
  if (typeof v === "string") {
    return v.split(/[、,]/).map((x) => x.trim()).filter(Boolean);
  }
  return [];
}
__name(getArrayOption, "getArrayOption");
async function fetchOtogeDbSongs() {
  let lastError = null;
  for (const url of OTOGE_DB_SONG_URLS) {
    try {
      const response = await fetch(url, {
        headers: {
          accept: "application/json,text/plain;q=0.9,*/*;q=0.8",
          "user-agent": "TKPoint-management-systems/1.0"
        }
      });
      if (!response.ok) {
        throw new Error(`fetch failed: ${response.status}`);
      }
      const payload = await response.json();
      if (Array.isArray(payload) && payload.length > 0) {
        return payload;
      }
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError ?? new Error("failed to fetch OTOGE DB songs");
}
__name(fetchOtogeDbSongs, "fetchOtogeDbSongs");
function normalizeOtogeSong(song) {
  const songId = String(song?.sort ?? "").trim();
  const title = String(song?.title ?? "").trim();
  const artist = String(song?.artist ?? "").trim();
  const version = String(song?.version ?? "").trim();
  if (!songId || !title || !artist || !version) {
    return null;
  }
  const charts = SONG_DIFFICULTY_FIELD_MAP.flatMap(({ field, chartSet, difficulty }) => {
    const level = String(song?.[field] ?? "").trim();
    if (!level) return [];
    return [
      {
        chartSet,
        difficulty,
        level,
        levelValue: parseLevelValue(level)
      }
    ];
  });
  if (charts.length === 0) {
    return null;
  }
  return {
    songId,
    title,
    artist,
    version,
    chartType: deriveChartType(charts),
    charts
  };
}
__name(normalizeOtogeSong, "normalizeOtogeSong");
function parseLevelValue(level) {
  const match = String(level ?? "").match(/\d+/);
  return match ? Number(match[0]) : null;
}
__name(parseLevelValue, "parseLevelValue");
function deriveChartType(charts) {
  const sets = new Set(charts.map((chart) => chart.chartSet));
  const hasStd = sets.has("STD");
  const hasDx = sets.has("DX");
  if (hasStd && hasDx) return "STD/DX";
  if (hasDx) return "DX";
  if (hasStd) return "STD";
  if (sets.has("UTAGE")) return "UTAGE";
  return "UNKNOWN";
}
__name(deriveChartType, "deriveChartType");
function getUserOption(options = [], name) {
  return options?.find((x) => x.name === name)?.value;
}
__name(getUserOption, "getUserOption");
function safeJsonParse(value, fallback) {
  try {
    return JSON.parse(value || "");
  } catch {
    return fallback;
  }
}
__name(safeJsonParse, "safeJsonParse");
function isAdmin(interaction, env) {
  const roles = interaction.member?.roles ?? [];
  return roles.includes(env.ADMIN_ROLE_ID);
}
__name(isAdmin, "isAdmin");
async function ensureUser(userId, db, userName = null) {
  await db.prepare(
    `INSERT INTO users (user_id, point, last_battle_at, insurance_used_at, bonus_multiplier, user_name)
     VALUES (?, 0, 0, 0, 0, COALESCE(?, ''))
     ON CONFLICT(user_id) DO NOTHING`
  ).bind(userId, userName).run();
  if (userName && userName.trim()) {
    await db.prepare("UPDATE users SET user_name = ? WHERE user_id = ?").bind(userName.trim(), userId).run();
  }
}
__name(ensureUser, "ensureUser");
async function logAction(db, userId, action, value) {
  await db.prepare("INSERT INTO logs (user_id, action, value, created_at) VALUES (?, ?, ?, ?)").bind(userId, action, value, Date.now()).run();
}
__name(logAction, "logAction");
function formatPoint(value) {
  return Number(value ?? 0).toFixed(2);
}
__name(formatPoint, "formatPoint");
async function verifyDiscordSignature(body, signature, timestamp, publicKeyHex) {
  if (!signature || !timestamp || !publicKeyHex) return false;
  const encoder = new TextEncoder();
  const message = encoder.encode(timestamp + body);
  const signatureBytes = hexToBytes(signature);
  const keyBytes = hexToBytes(publicKeyHex);
  const cryptoKey = await crypto.subtle.importKey("raw", keyBytes, { name: "Ed25519" }, false, ["verify"]);
  return crypto.subtle.verify("Ed25519", cryptoKey, signatureBytes, message);
}
__name(verifyDiscordSignature, "verifyDiscordSignature");
function hexToBytes(hex) {
  if (!hex || hex.length % 2 !== 0) return new Uint8Array();
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}
__name(hexToBytes, "hexToBytes");
function interactionResponse(content, ephemeral = false) {
  return jsonResponse({
    type: DISCORD_RESPONSE_TYPE.CHANNEL_MESSAGE_WITH_SOURCE,
    data: {
      content,
      ...ephemeral ? { flags: EPHEMERAL_FLAG } : {}
    }
  });
}
__name(interactionResponse, "interactionResponse");
function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json; charset=UTF-8" }
  });
}
__name(jsonResponse, "jsonResponse");
async function handleRejectBattle(interaction, userId, env) {
  await ensureUser(userId, env.DB);
  const battle = await env.DB.prepare(
    `SELECT * FROM battles
     WHERE status IN ('pending', 'active', 'awaiting_approval')
       AND (player_a = ? OR player_b = ?)
     ORDER BY created_at DESC LIMIT 1`
  ).bind(userId, userId).first();
  if (!battle) {
    return interactionResponse("\u62D2\u5426\u3067\u304D\u308B\u9032\u884C\u4E2D\u306E\u30D0\u30C8\u30EB\u304C\u306A\u3044\u3088\uFF01", true);
  }
  const opponent = battle.player_a === userId ? battle.player_b : battle.player_a;
  await env.DB.prepare(
    `UPDATE battles SET status = 'rejected' WHERE id = ?`
  ).bind(battle.id).run();
  await logAction(env.DB, userId, "battle_reject", 0);
  return interactionResponse(
    `\u9032\u884C\u4E2D\u306E\u30D0\u30C8\u30EB\u3092\u62D2\u5426\u3057\u305F\u3088\uFF01 <@${opponent}> \u3082\u3053\u308C\u3067\u65B0\u3057\u304F /battle \u304C\u6253\u3066\u308B\u3088\u3046\u306B\u306A\u3063\u305F\u3088\u3002 battleId: ${battle.id}`
  );
}
__name(handleRejectBattle, "handleRejectBattle");
export {
  index_default as default
};
//# sourceMappingURL=index.js.map
