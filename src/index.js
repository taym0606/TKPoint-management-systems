const DISCORD_INTERACTION_TYPE = {
  PING: 1,
  APPLICATION_COMMAND: 2,
};

const DISCORD_RESPONSE_TYPE = {
  PONG: 1,
  CHANNEL_MESSAGE_WITH_SOURCE: 4,
};

const EPHEMERAL_FLAG = 1 << 6;
const THREE_DAYS_MS = 3 * 24 * 60 * 60 * 1000;

const ACHIEVEMENT_POINTS = {
  SSS: 0.5,
  'SSS+': 1,
  FC: 0.5,
  'FC+': 1,
  AP: 2.5,
  'AP+': 4,
  '星5': 2.5,
};

const OPTION_POINTS = {
  明るいバー: 1.5,
  'スライド+1': 0.5,
  全反転: 0.5,
};

const DIFFICULTY_MULTIPLIER = {
  '14+': 1.3,
  '14': 1.0,
  '13+': 0.7,
};

export default {
  async fetch(request, env) {
    if (request.method !== 'POST') {
      return jsonResponse({ error: 'Method Not Allowed' }, 405);
    }

    const body = await request.text();
    const signature = request.headers.get('x-signature-ed25519');
    const timestamp = request.headers.get('x-signature-timestamp');

    const isValid = await verifyDiscordSignature(body, signature, timestamp, env.DISCORD_PUBLIC_KEY);
    if (!isValid) {
      return jsonResponse({ error: 'Invalid request signature' }, 401);
    }

    const interaction = JSON.parse(body);

    if (interaction.type === DISCORD_INTERACTION_TYPE.PING) {
      return jsonResponse({ type: DISCORD_RESPONSE_TYPE.PONG });
    }

    if (interaction.type !== DISCORD_INTERACTION_TYPE.APPLICATION_COMMAND) {
      return interactionResponse('Unsupported interaction type', true);
    }

    await ensureUsersTableColumns(env.DB);

    try {
      return await routeCommand(interaction, env);
    } catch (error) {
      console.error(error);
      return interactionResponse('内部が壊れてるかも...りむのんに連絡お願い～', true);
    }
  },
};

async function routeCommand(interaction, env) {
  const command = interaction.data?.name;
  const userId = interaction.member?.user?.id ?? interaction.user?.id;
  const userName = getInteractionDisplayName(interaction, userId);
  await ensureUser(userId, env.DB, userName);

  switch (command) {
    case 'pt':
      return handlePoint(interaction, userId, env);
    case 'submit':
      return handleSubmit(interaction, userId, env);
    case 'battle':
      return handleBattle(interaction, userId, env);
    case 'startbattle':
      return handleStartBattle(interaction, userId, env);
    case 'result':
      return handleResult(interaction, userId, env);
    case 'approve':
      return handleApprove(interaction, userId, env);
    case 'reject':
      return handleReject(interaction, userId, env);
    case 'battlereject':
      return handleRejectBattle(interaction, userId, env);
    case 'ranking':
      return handleRanking(env);
    case 'add':
      return handleAdd(interaction, userId, env);
    default:
      return interactionResponse(`未対応コマンド: ${command}`, true);
  }
}

async function handlePoint(interaction, userId, env) {
  await ensureUser(userId, env.DB, getInteractionDisplayName(interaction, userId));
  const row = await env.DB.prepare('SELECT point FROM users WHERE user_id = ?').bind(userId).first();
  const displayName = getInteractionDisplayName(interaction, userId);
  return interactionResponse(`${displayName} の現在のポイントは... **${formatPoint(row?.point ?? 0)}**ptだよ!`);
}

async function handleSubmit(interaction, userId, env) {
  await ensureUser(userId, env.DB);

  const subcommand = interaction.data?.options?.[0];
  if (!subcommand || subcommand.name !== 'score') {
    return interactionResponse('/submit score のみ対応してるよ。', true);
  }

  const difficulty = getStringOption(subcommand.options, 'difficulty');
  const achievements = getSelectedAchievements(subcommand.options);
  const options = getArrayOption(subcommand.options, 'options');
  const multiplied = getBooleanOption(subcommand.options, 'multiplied');

  if (!DIFFICULTY_MULTIPLIER[difficulty]) {
    return interactionResponse('difficulty は 14+ / 14 / 13+ だけだよ！', true);
  }

  const weekId = getCurrentWeekId();
  const duplicate = await env.DB.prepare(
    'SELECT id FROM score_submissions WHERE user_id = ? AND difficulty = ? AND week_id = ?'
  )
    .bind(userId, difficulty, weekId)
    .first();

  if (duplicate) {
    return interactionResponse('すでに申請済みだよ～！ずるしないでね', true);
  }

  const score = calculateScorePoint({ difficulty, achievements, options, multiplied });
  const requestId = crypto.randomUUID();

  await env.DB.prepare(
    `INSERT INTO requests (id, type, user_id, data, calculated_point, status, created_at)
     VALUES (?, 'score', ?, ?, ?, 'pending', ?)`
  )
    .bind(
      requestId,
      userId,
      JSON.stringify({ difficulty, achievements, options, multiplied, weekId }),
      score,
      Date.now()
    )
    .run();

  await logAction(env.DB, userId, 'submit_score_request', score);

  return interactionResponse(
    `君の今回頑張ったスコアを申請したよ! requestId: \
${requestId}\n君の今回のポイントは...**${formatPoint(score)}**pt（承認待ち）`
  );
}

async function handleBattle(interaction, userId, env) {
  await ensureUser(userId, env.DB);

  const targetId = getUserOption(interaction.data?.options, 'user');
  if (!targetId || targetId === userId) {
    return interactionResponse('君にふさわしい相手をちゃんと選んでね？', true);
  }

  await ensureUser(targetId, env.DB);

  // ★ ユーザーが進行中のバトルを持っていないかチェック ★
  const existingBattle = await env.DB.prepare(
    `SELECT * FROM battles
     WHERE status IN ('pending', 'active', 'awaiting_approval')
       AND (player_a = ? OR player_b = ?)
     ORDER BY created_at DESC LIMIT 1`
  ).bind(userId, userId).first();

  if (existingBattle) {
    return interactionResponse(
      `まだ進行中の対戦があるよ！battleId: ${existingBattle.id} を終えてから新しい対戦を作ってね♪`,
      true
    );
  }

  // 対戦相手も同様にチェック
  const targetBattle = await env.DB.prepare(
    `SELECT * FROM battles
     WHERE status IN ('pending', 'active', 'awaiting_approval')
       AND (player_a = ? OR player_b = ?)
     ORDER BY created_at DESC LIMIT 1`
  ).bind(targetId, targetId).first();

  if (targetBattle) {
    return interactionResponse(
      `選んだ相手 <@${targetId}> はまだ進行中の対戦があるよ！別の相手を選んでね♪`,
      true
    );
  }

  const now = Date.now();
  const battleId = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO battles (id, player_a, player_b, bet_a, bet_b, status, thread_id, result, created_at)
     VALUES (?, ?, ?, NULL, NULL, 'pending', '', '{}', ?)`
  ).bind(battleId, userId, targetId, now).run();

  await logAction(env.DB, userId, 'battle_create', 0);

  return interactionResponse(`<@${targetId}>との対戦を作成したよ！頑張ろう！ battleId: ${battleId}`);
}

async function handleStartBattle(interaction, userId, env) {
  const amount = getNumberOption(interaction.data?.options, 'amount');
  if (!amount || amount <= 0) {
    return interactionResponse('amount は 0 より大きい値を指定してね！', true);
  }

  await ensureUser(userId, env.DB);
  const now = Date.now();
  const me = await env.DB.prepare('SELECT point, last_battle_at FROM users WHERE user_id = ?').bind(userId).first();

  if ((me?.point ?? 0) < amount) {
    return interactionResponse('そんなにポイント持ってないよ～！', true);
  }

  const battle = await env.DB.prepare(
    `SELECT * FROM battles
     WHERE status = 'pending' AND (player_a = ? OR player_b = ?)
     ORDER BY created_at DESC LIMIT 1`
  )
    .bind(userId, userId)
    .first();

  if (!battle) {
    return interactionResponse('まだ対戦相手見つけてないかも？/battleで対戦相手を選んでね♪', true);
  }

  const isA = battle.player_a === userId;
  const betA = isA ? amount : battle.bet_a;
  const betB = isA ? battle.bet_b : amount;
  const nextStatus = betA != null && betB != null ? 'active' : 'pending';

  await env.DB.prepare('UPDATE battles SET bet_a = ?, bet_b = ?, status = ? WHERE id = ?')
    .bind(betA, betB, nextStatus, battle.id)
    .run();

  await logAction(env.DB, userId, 'battle_bet', amount);

  // ★ ここからポイント引き落とし処理 ★
  if (nextStatus === 'active') {
    const players = [battle.player_a, battle.player_b];
    const bets = [betA, betB];
    for (let i = 0; i < 2; i++) {
      await env.DB.prepare(
        'UPDATE users SET point = point - ? WHERE user_id = ?'
      ).bind(bets[i], players[i]).run();
    }
  }
  // ★ ポイント引き落とし処理ここまで ★

  return interactionResponse(
    nextStatus === 'active'
      ? `ベット確定するね♪  二人の掛けた金額は...<@${battle.player_a}>:${betA}と<@${battle.player_b}>:${betB}だよ！合計は${betA + betB}`
      : `ベット受付するね♪ 相手の入力待ちだよ～！`
  );
}

async function handleResult(interaction, userId, env) {
  const result = getStringOption(interaction.data?.options, 'result');
  if (!['win', 'lose'].includes(result)) {
    return interactionResponse('result は win または lose を指定してね！', true);
  }

  // 直近のアクティブなバトルを取得
  const battle = await env.DB.prepare(
    `SELECT * FROM battles
     WHERE status = 'active' AND (player_a = ? OR player_b = ?)
     ORDER BY created_at DESC LIMIT 1`
  )
    .bind(userId, userId)
    .first();

  if (!battle) {
    return interactionResponse('まだ試合初めてないかも？', true);
  }

  // 自分の結果を記録
  const currentResult = safeJsonParse(battle.result, {});
  currentResult[userId] = result;

  await env.DB.prepare('UPDATE battles SET result = ? WHERE id = ?')
    .bind(JSON.stringify(currentResult), battle.id)
    .run();

  const aResult = currentResult[battle.player_a];
  const bResult = currentResult[battle.player_b];

  if (!aResult || !bResult) {
    return interactionResponse('君の結果は記録したよ！相手を待ってね！');
  }

  if (aResult === bResult) {
    return interactionResponse('あれ？結果があわないぞ？りむのんを呼んで～💦', true);
  }

  // 勝者と敗者を決定
  const winner = aResult === 'win' ? battle.player_a : battle.player_b;
  const loser = winner === battle.player_a ? battle.player_b : battle.player_a;

  // ベット合計から勝者70％、敗者30％を計算
  const totalBet = battle.bet_a + battle.bet_b;
  const winnerPoint = totalBet;
  const loserPoint = 0;

  const requestId = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO requests (id, type, user_id, data, calculated_point, status, created_at)
     VALUES (?, 'resolve', ?, ?, ?, 'pending', ?)`
  )
    .bind(
      requestId,
      winner,
      JSON.stringify({
        battleId: battle.id,
        winner,
        loser,
        betA: battle.bet_a,
        betB: battle.bet_b,
        winnerPoint,
        loserPoint,
        insuranceUsed: false,
      }),
      winnerPoint, // calculated_point に勝者ポイントを入れる
      Date.now()
    )
    .run();

  // バトル状態を承認待ちに更新
  await env.DB.prepare(
    "UPDATE battles SET status = 'awaiting_approval' WHERE id = ?"
  ).bind(battle.id).run();

  return interactionResponse(
    `よーし結果を入力できたね。お疲れ様！ りむのんに認証してもらってね♪ requestId: ${requestId}`
  );
}
async function handleApprove(interaction, userId, env) {
  if (!isAdmin(interaction, env)) {
    return interactionResponse('このコマンドは運営のみ使用できます。', true);
  }

  const requestId = getStringOption(interaction.data?.options, 'requestid');
  if (!requestId) return interactionResponse('requestId が必要だよ', true);

  const req = await env.DB.prepare('SELECT * FROM requests WHERE id = ?').bind(requestId).first();
  if (!req) return interactionResponse('requestが見つからないよ', true);
  if (req.status !== 'pending') return interactionResponse('既に処理済みのrequestだよ。', true);

  const data = safeJsonParse(req.data, {});

  if (req.type === 'score') {
    await ensureUser(req.user_id, env.DB);
    await env.DB.prepare('UPDATE users SET point = point + ? WHERE user_id = ?')
      .bind(req.calculated_point, req.user_id)
      .run();

    await env.DB.prepare(
      'INSERT OR IGNORE INTO score_submissions (user_id, difficulty, week_id) VALUES (?, ?, ?)'
    )
      .bind(req.user_id, data.difficulty, data.weekId)
      .run();

    await logAction(env.DB, req.user_id, 'approve_score', req.calculated_point);
  } else if (req.type === 'resolve') {
    const winner = data.winner;
    const loser = data.loser;
    const battle = await env.DB.prepare('SELECT player_a, player_b, bet_a, bet_b FROM battles WHERE id = ?')
      .bind(data.battleId)
      .first();
    if (!battle) {
      return interactionResponse('関連battleが見つかりません。', true);
    }
    const loserBet = Number(loser === battle.player_a ? battle.bet_a : battle.bet_b);
    const winnerGainSource = Number(winner === battle.player_a ? battle.bet_b : battle.bet_a);

    const gain = Number((winnerGainSource ?? 0) * 0.7);
    const loss = Number((loserBet ?? 0) * 0.7);
    let refund = Number((loserBet ?? 0) * 0.3);

    if (data.insuranceUsed) {
      refund += Number((loserBet ?? 0) * 0.2);
      await env.DB.prepare('UPDATE users SET insurance_used_at = ? WHERE user_id = ?').bind(Date.now(), loser).run();
    }

    const loserNet = -loss + refund;

    await ensureUser(winner, env.DB);
    await ensureUser(loser, env.DB);

    await env.DB.prepare('UPDATE users SET point = point + ?, last_battle_at = ? WHERE user_id = ?')
      .bind(gain, Date.now(), winner)
      .run();

    await env.DB.prepare(
      'UPDATE users SET point = point + ?, bonus_multiplier = bonus_multiplier + 0.1, last_battle_at = ? WHERE user_id = ?'
    )
      .bind(loserNet, Date.now(), loser)
      .run();

    await env.DB.prepare("UPDATE battles SET status = 'resolved' WHERE id = ?").bind(data.battleId).run();

    await logAction(env.DB, winner, 'approve_battle_win', gain);
    await logAction(env.DB, loser, 'approve_battle_lose', loserNet);
  } else if (req.type === 'exchange') {
    await ensureUser(req.user_id, env.DB);
    const cost = Number(data.cost ?? 0);
    await env.DB.prepare('UPDATE users SET point = point - ? WHERE user_id = ?').bind(cost, req.user_id).run();
    await logAction(env.DB, req.user_id, 'approve_exchange', -cost);
  } else {
    return interactionResponse(`未知の request type: ${req.type}`, true);
  }

  await env.DB.prepare("UPDATE requests SET status = 'approved' WHERE id = ?").bind(requestId).run();
  return interactionResponse(`request ${requestId} を承認したよ♪`);
}

async function handleReject(interaction, userId, env) {
  if (!isAdmin(interaction, env)) {
    return interactionResponse('このコマンドは運営のみ使用できます。', true);
  }

  const requestId = getStringOption(interaction.data?.options, 'requestid');
  if (!requestId) return interactionResponse('requestId が必要です。', true);

  const result = await env.DB.prepare("UPDATE requests SET status = 'rejected' WHERE id = ? AND status = 'pending'")
    .bind(requestId)
    .run();

  if ((result.meta?.changes ?? 0) === 0) {
    return interactionResponse('pending request が見つからないよ～', true);
  }

  return interactionResponse(`ごめんね。request ${requestId} を却下したよ。`);
}

async function handleRanking(env) {
  const rows = await env.DB.prepare('SELECT user_id, point, user_name FROM users ORDER BY point DESC LIMIT 10').all();
  const ranked = rows.results ?? [];

  const lines = await Promise.all(
    ranked.map(async (row, idx) => {
      const dbName = String(row.user_name ?? '').trim();
      const name = dbName || (await fetchDiscordDisplayName(row.user_id, env));
      return `${idx + 1}. ${name} - ${formatPoint(row.point)}pt`;
    })
  );

  return interactionResponse(lines.join('\n') || 'ランキングデータがありません。');
}

async function handleAdd(interaction, userId, env) {
  if (!isAdmin(interaction, env)) {
    return interactionResponse('このコマンドは運営のみ使用できます。', true);
  }

  const targetId = getUserOption(interaction.data?.options, 'player');
  const delta = getNumberOption(interaction.data?.options, 'point');

  if (!targetId) {
    return interactionResponse('player を指定してください。', true);
  }

  if (!Number.isFinite(delta) || delta === 0) {
    return interactionResponse('point は 0 以外の数値を指定してください。', true);
  }

  const targetResolved = interaction.data?.resolved?.users?.[targetId];
  const targetResolvedName = targetResolved?.global_name ?? targetResolved?.username ?? null;
  await ensureUser(targetId, env.DB, targetResolvedName);
  await env.DB.prepare('UPDATE users SET point = point + ? WHERE user_id = ?').bind(delta, targetId).run();

  const updated = await env.DB.prepare('SELECT point FROM users WHERE user_id = ?').bind(targetId).first();
  await logAction(env.DB, userId, 'admin_add_point', delta);

  const targetUser = interaction.data?.resolved?.users?.[targetId];
  const targetName = targetUser?.global_name ?? targetUser?.username ?? targetId;
  return interactionResponse(
    `${targetName} に ${formatPoint(delta)}pt を反映したよ！現在のポイントは **${formatPoint(updated?.point ?? 0)}**pt:だよ！`
  );
}


async function ensureUsersTableColumns(db) {
  try {
    await db.prepare("ALTER TABLE users ADD COLUMN user_name TEXT DEFAULT ''").run();
  } catch {
    // already exists
  }
}

function getInteractionDisplayName(interaction, fallback = '') {
  return (
    interaction.member?.nick ??
    interaction.member?.user?.global_name ??
    interaction.member?.user?.username ??
    interaction.user?.global_name ??
    interaction.user?.username ??
    fallback
  );
}

async function fetchDiscordDisplayName(userId, env) {
  const botToken = env.DISCORD_BOT_TOKEN;
  if (!botToken) return userId;

  try {
    const res = await fetch(`https://discord.com/api/v10/users/${userId}`, {
      headers: { Authorization: `Bot ${botToken}` },
    });

    if (!res.ok) return userId;
    const user = await res.json();
    return user.global_name || user.username || userId;
  } catch {
    return userId;
  }
}
function calculateScorePoint({ difficulty, achievements, options }) {
  const normalized = normalizeAchievements(achievements);
  const hasAtLeastSSS = normalized.includes('SSS') || normalized.includes('SSS+');

  const basic = normalized.reduce((sum, key) => sum + (ACHIEVEMENT_POINTS[key] ?? 0), 0);
  const option = hasAtLeastSSS
    ? options.reduce((sum, key) => sum + (OPTION_POINTS[key] ?? 0), 0)
    : 0;

  return (basic + option) * DIFFICULTY_MULTIPLIER[difficulty];
}

function normalizeAchievements(list) {
  const set = new Set(list);
  if (set.has('SSS+')) set.delete('SSS');
  return [...set];
}

function getCurrentWeekId() {
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), 0, 1));
  const days = Math.floor((now - start) / 86400000);
  return Number(`${now.getUTCFullYear()}${String(Math.ceil((days + start.getUTCDay() + 1) / 7)).padStart(2, '0')}`);
}

function getMonthStartTimestamp() {
  const now = new Date();
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
}

function getStringOption(options = [], name) {
  return options?.find((x) => x.name === name)?.value;
}

function getNumberOption(options = [], name) {
  const v = options?.find((x) => x.name === name)?.value;
  return Number(v);
}

function getBooleanOption(options = [], name) {
  return Boolean(options?.find((x) => x.name === name)?.value);
}

function getSelectedAchievements(options = []) {
  const csv = getArrayOption(options, 'achievements');
  if (csv.length > 0) return csv;

  const map = [
    ['sss', 'SSS'],
    ['sss_plus', 'SSS+'],
    ['fc', 'FC'],
    ['fc_plus', 'FC+'],
    ['ap', 'AP'],
    ['ap_plus', 'AP+'],
    ['star5', '星5'],
  ];

  return map.filter(([key]) => getBooleanOption(options, key)).map(([, label]) => label);
}

function getArrayOption(options = [], name) {
  const v = options?.find((x) => x.name === name)?.value;
  if (Array.isArray(v)) return v;
  if (typeof v === 'string') {
    return v
      .split(/[、,]/)
      .map((x) => x.trim())
      .filter(Boolean);
  }
  return [];
}

function getUserOption(options = [], name) {
  return options?.find((x) => x.name === name)?.value;
}

function safeJsonParse(value, fallback) {
  try {
    return JSON.parse(value || '');
  } catch {
    return fallback;
  }
}

function isAdmin(interaction, env) {
  const roles = interaction.member?.roles ?? [];
  return roles.includes(env.ADMIN_ROLE_ID);
}

async function ensureUser(userId, db, userName = null) {
  await db.prepare(
    `INSERT INTO users (user_id, point, last_battle_at, insurance_used_at, bonus_multiplier, user_name)
     VALUES (?, 0, 0, 0, 0, COALESCE(?, ''))
     ON CONFLICT(user_id) DO NOTHING`
  )
    .bind(userId, userName)
    .run();

  if (userName && userName.trim()) {
    await db.prepare('UPDATE users SET user_name = ? WHERE user_id = ?').bind(userName.trim(), userId).run();
  }
}

async function logAction(db, userId, action, value) {
  await db.prepare('INSERT INTO logs (user_id, action, value, created_at) VALUES (?, ?, ?, ?)')
    .bind(userId, action, value, Date.now())
    .run();
}

function formatPoint(value) {
  return Number(value ?? 0).toFixed(2);
}

async function verifyDiscordSignature(body, signature, timestamp, publicKeyHex) {
  if (!signature || !timestamp || !publicKeyHex) return false;
  const encoder = new TextEncoder();
  const message = encoder.encode(timestamp + body);

  const signatureBytes = hexToBytes(signature);
  const keyBytes = hexToBytes(publicKeyHex);

  const cryptoKey = await crypto.subtle.importKey('raw', keyBytes, { name: 'Ed25519' }, false, ['verify']);
  return crypto.subtle.verify('Ed25519', cryptoKey, signatureBytes, message);
}

function hexToBytes(hex) {
  if (!hex || hex.length % 2 !== 0) return new Uint8Array();
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

function interactionResponse(content, ephemeral = false) {
  return jsonResponse({
    type: DISCORD_RESPONSE_TYPE.CHANNEL_MESSAGE_WITH_SOURCE,
    data: {
      content,
      ...(ephemeral ? { flags: EPHEMERAL_FLAG } : {}),
    },
  });
}

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json; charset=UTF-8' },
  });
}

async function handleRejectBattle(interaction, userId, env) {
  await ensureUser(userId, env.DB);

  // 進行中のバトルを取得（pending, active, awaiting_approval）
  const battle = await env.DB.prepare(
    `SELECT * FROM battles
     WHERE status IN ('pending', 'active', 'awaiting_approval')
       AND (player_a = ? OR player_b = ?)
     ORDER BY created_at DESC LIMIT 1`
  ).bind(userId, userId).first();

  if (!battle) {
    return interactionResponse('拒否できる進行中のバトルがないよ！', true);
  }

  const opponent = battle.player_a === userId ? battle.player_b : battle.player_a;

  // バトルを拒否済みにしてキャンセル
  await env.DB.prepare(
    `UPDATE battles SET status = 'rejected' WHERE id = ?`
  ).bind(battle.id).run();

  await logAction(env.DB, userId, 'battle_reject', 0);

  return interactionResponse(
    `進行中のバトルを拒否したよ！ <@${opponent}> もこれで新しく /battle が打てるようになったよ。 battleId: ${battle.id}`
  );
}