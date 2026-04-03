const DISCORD_INTERACTION_TYPE = {
  PING: 1,
  APPLICATION_COMMAND: 2,
};

const DISCORD_RESPONSE_TYPE = {
  PONG: 1,
  CHANNEL_MESSAGE_WITH_SOURCE: 4,
  DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE: 5,
};

const EPHEMERAL_FLAG = 1 << 6;
const THREE_DAYS_MS = 3 * 24 * 60 * 60 * 1000;

const OTOGE_DB_SONG_URLS = [
  'https://otoge-db.net/maimai/data/maimai_songs.json',
  'https://raw.githubusercontent.com/zvuc/otoge-db/master/maimai/data/maimai_songs.json',
];

const SONG_DIFFICULTY_FIELD_MAP = [
  { field: 'lev_bas', chartSet: 'STD', difficulty: 'BASIC' },
  { field: 'lev_adv', chartSet: 'STD', difficulty: 'ADVANCED' },
  { field: 'lev_exp', chartSet: 'STD', difficulty: 'EXPERT' },
  { field: 'lev_mas', chartSet: 'STD', difficulty: 'MASTER' },
  { field: 'lev_remas', chartSet: 'STD', difficulty: 'Re:MASTER' },
  { field: 'dx_lev_bas', chartSet: 'DX', difficulty: 'BASIC' },
  { field: 'dx_lev_adv', chartSet: 'DX', difficulty: 'ADVANCED' },
  { field: 'dx_lev_exp', chartSet: 'DX', difficulty: 'EXPERT' },
  { field: 'dx_lev_mas', chartSet: 'DX', difficulty: 'MASTER' },
  { field: 'dx_lev_remas', chartSet: 'DX', difficulty: 'Re:MASTER' },
  { field: 'lev_utage', chartSet: 'UTAGE', difficulty: 'UTAGE' },
];

const BASE_SUBMISSION_POINT = 1;

const ACHIEVEMENT_POINTS = {
  SSS: 1,
  'SSS+': 1.5,
  SCORE_1008500: 2,
  FC: 0.5,
  'FC+': 2,
  AP: 3,
  'AP+': 7,
  STAR4: 0.5,
  STAR5: 3,
  SAME4: 2,
};

const SPECIAL_OPTION_POINTS = {
  BRIGHT_BAR: 2,
  SLIDE_PLUS_ONE: 0.5,
  MIRROR: 0.3,
};

const DIFFICULTY_MULTIPLIER = {
  '14+': 1.3,
  '14': 1.0,
  '13+': 0.7,
};

export default {
  async fetch(request, env, ctx) {
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
    await ensureSongTables(env.DB);

    try {
      return await routeCommand(interaction, env, ctx);
    } catch (error) {
      console.error(error);
      return interactionResponse('内部が壊れてるかも...りむのんに連絡お願い～', true);
    }
  },
};

async function routeCommand(interaction, env, ctx) {
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
    case 'updatesongs':
      return handleUpdateSongs(interaction, env, ctx);
    case 'omikuzi':
      return handleOmikuzi(interaction, env);
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
  const options = getSelectedSpecialOptions(subcommand.options);
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

  const achievementSummary = formatSubmitSelection(achievements, formatAchievementLabel);
  const optionSummary = formatSubmitSelection(options, formatSpecialOptionLabel);

  return interactionResponse(
    `スコア申請を受け付けたよ! requestId: ${requestId}
難易度: ${difficulty}
達成項目: ${achievementSummary}
特殊項目: ${optionSummary}
週倍率: ${multiplied ? 'あり' : 'なし'}
今回のポイント: **${formatPoint(score)}**pt（承認待ち）`
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

  const requestId = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO requests (id, type, user_id, data, calculated_point, status, created_at)
     VALUES (?, 'resolve', ?, ?, ?, 'pending', ?)`
  )
    .bind(
      requestId,                         // id
      winner,                            // user_id
      JSON.stringify({
        battleId: battle.id,
        winner,
        loser,
        betA: battle.bet_a,
        betB: battle.bet_b,
        insuranceUsed: false,
      }),                                 // data
      0,                                 // calculated_point（バトルなので一旦0）
      Date.now()                          // created_at
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
    // スコア承認処理
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
    // バトル承認処理
    const winner = data.winner;
    const loser = data.loser;

    const battle = await env.DB.prepare('SELECT player_a, player_b, bet_a, bet_b FROM battles WHERE id = ?')
      .bind(data.battleId)
      .first();
    if (!battle) return interactionResponse('関連battleが見つかりません。', true);

    // 掛け金を数値化
    const loserBet = Number(loser === battle.player_a ? battle.bet_a : battle.bet_b);
    const winnerBet = Number(winner === battle.player_a ? battle.bet_a : battle.bet_b);

    // 勝者の獲得金額 = 自分の掛け金 + 負けた人の掛け金の80%
    const gain = winnerBet + loserBet * 0.8;

    // 敗者の損失 = 自分の掛け金の80%（残り20%は保持）
    const loss = loserBet * 0.2;
    const loserNet = -loss; // 保険なしなのでシンプル

    await ensureUser(winner, env.DB);
    await ensureUser(loser, env.DB);

    // 勝者ポイント更新
    await env.DB.prepare('UPDATE users SET point = point + ?, last_battle_at = ? WHERE user_id = ?')
      .bind(gain, Date.now(), winner)
      .run();

    // 敗者ポイント更新
    await env.DB.prepare(
      'UPDATE users SET point = point + ?, bonus_multiplier = bonus_multiplier + 0.1, last_battle_at = ? WHERE user_id = ?'
    )
      .bind(loss, Date.now(), loser)
      .run();

    // バトルステータス更新
    await env.DB.prepare("UPDATE battles SET status = 'resolved' WHERE id = ?")
      .bind(data.battleId)
      .run();

    // ログ記録
    await logAction(env.DB, winner, 'approve_battle_win', gain);
    await logAction(env.DB, loser, 'approve_battle_lose', loserNet);

  } else if (req.type === 'exchange') {
    // ポイント交換処理
    await ensureUser(req.user_id, env.DB);
    const cost = Number(data?.cost ?? 0);
    await env.DB.prepare('UPDATE users SET point = point - ? WHERE user_id = ?')
      .bind(cost, req.user_id)
      .run();

    await logAction(env.DB, req.user_id, 'approve_exchange', -cost);

  } else {
    return interactionResponse(`未知の request type: ${req.type}`, true);
  }

  // request を承認済みにする
  await env.DB.prepare("UPDATE requests SET status = 'approved' WHERE id = ?")
    .bind(requestId)
    .run();

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

async function handleUpdateSongs(interaction, env, ctx) {
  if (!isAdmin(interaction, env)) {
    return interactionResponse('このコマンドは運営のみ使用できます。', true);
  }

  ctx.waitUntil(processSongUpdate(interaction, env));
  return deferredInteractionResponse('曲データ更新を開始しました。完了後に結果を送信します。');
}

async function handleOmikuzi(interaction, env) {
  const level = getStringOption(interaction.data?.options, 'difficulty');
  if (!isValidOmikuziLevel(level)) {
    return interactionResponse('difficulty は 1 から 15 の範囲で、7+ などを含めて指定してください。', true);
  }

  const song = await env.DB.prepare(
    `SELECT DISTINCT s.song_id, s.title, s.artist, s.version, s.chart_type
     FROM songs s
     INNER JOIN song_charts c ON c.song_id = s.song_id
     WHERE c.level = ? AND c.chart_set IN ('STD', 'DX')
     ORDER BY RANDOM()
     LIMIT 1`
  ).bind(level).first();

  if (!song) {
    return interactionResponse(
      `レベル ${level} の曲データがありません。先に /updatesongs を実行してください。`,
      true
    );
  }

  const matched = await env.DB.prepare(
    `SELECT chart_set, difficulty, level
     FROM song_charts
     WHERE song_id = ? AND level = ? AND chart_set IN ('STD', 'DX')
     ORDER BY CASE chart_set WHEN 'STD' THEN 0 WHEN 'DX' THEN 1 ELSE 2 END, difficulty`
  ).bind(song.song_id, level).all();

  const matchedCharts = (matched.results ?? []).map(
    (chart) => `${chart.chart_set} ${chart.difficulty} ${chart.level}`
  );

  return interactionResponse(
    [
      `レベル ${level} おみくじ結果`,
      `曲名: **${song.title}**`,
      `アーティスト: ${song.artist}`,
      `バージョン: ${song.version}`,
      `種別: ${song.chart_type}`,
      `該当譜面: ${matchedCharts.join(' / ') || 'なし'}`,
    ].join('\n')
  );
}

async function processSongUpdate(interaction, env) {
  try {
    const songs = await fetchOtogeDbSongs();
    if (!songs.length) {
      await sendInteractionFollowup(interaction, '曲データを取得できませんでした。');
      return;
    }

    const syncedAt = Date.now();
    const batchSize = 100;
    let songCount = 0;
    let chartCount = 0;
    let statements = [];

    for (const rawSong of songs) {
      const song = normalizeOtogeSong(rawSong);
      if (!song) continue;

      songCount += 1;
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

    await env.DB.prepare('DELETE FROM song_charts WHERE synced_at <> ?').bind(syncedAt).run();
    await env.DB.prepare('DELETE FROM songs WHERE synced_at <> ?').bind(syncedAt).run();

    await sendInteractionFollowup(
      interaction,
      `曲データを更新しました。\n対象曲数: ${songCount} 曲\n譜面数: ${chartCount} 件\n更新元: OTOGE DB`
    );
  } catch (error) {
    console.error(error);
    await sendInteractionFollowup(interaction, `曲データ更新に失敗しました: ${error.message}`);
  }
}


async function ensureUsersTableColumns(db) {
  try {
    await db.prepare("ALTER TABLE users ADD COLUMN user_name TEXT DEFAULT ''").run();
  } catch {
    // already exists
  }
}

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

  const basic = BASE_SUBMISSION_POINT + normalized.reduce((sum, key) => sum + (ACHIEVEMENT_POINTS[key] ?? 0), 0);
  const option = hasAtLeastSSS
    ? normalizeSpecialOptions(options).reduce((sum, key) => sum + (SPECIAL_OPTION_POINTS[key] ?? 0), 0)
    : 0;

  return (basic + option) * DIFFICULTY_MULTIPLIER[difficulty];
}

function normalizeAchievements(list) {
  const set = new Set(list);
  if (set.has('SSS+')) set.delete('SSS');
  return [...set];
}

function normalizeSpecialOptions(list) {
  return [...new Set(list)];
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
  if (csv.length > 0) return csv.map(normalizeAchievementLabel).filter(Boolean);

  const map = [
    ['sss', 'SSS'],
    ['sss_plus', 'SSS+'],
    ['score_1008500', 'SCORE_1008500'],
    ['fc', 'FC'],
    ['fc_plus', 'FC+'],
    ['ap', 'AP'],
    ['ap_plus', 'AP+'],
    ['star4', 'STAR4'],
    ['star5', 'STAR5'],
    ['same4', 'SAME4'],
  ];

  return map.filter(([key]) => getBooleanOption(options, key)).map(([, label]) => label);
}

function getSelectedSpecialOptions(options = []) {
  const csv = getArrayOption(options, 'options').map(normalizeSpecialOptionLabel).filter(Boolean);

  const map = [
    ['bright_bar', 'BRIGHT_BAR'],
    ['slide_plus_one', 'SLIDE_PLUS_ONE'],
    ['mirror', 'MIRROR'],
  ];

  return [
    ...csv,
    ...map.filter(([key]) => getBooleanOption(options, key)).map(([, label]) => label),
  ];
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

function normalizeAchievementLabel(label) {
  const value = String(label ?? '').trim().toUpperCase();
  const map = {
    SSS: 'SSS',
    'SSS+': 'SSS+',
    '100.8500': 'SCORE_1008500',
    '100.8500+': 'SCORE_1008500',
    SCORE_1008500: 'SCORE_1008500',
    FC: 'FC',
    'FC+': 'FC+',
    AP: 'AP',
    'AP+': 'AP+',
    STAR4: 'STAR4',
    '星4': 'STAR4',
    STAR5: 'STAR5',
    '星5': 'STAR5',
    SAME4: 'SAME4',
    '下4桁ゾロ目': 'SAME4',
  };

  return map[value] ?? null;
}

function normalizeSpecialOptionLabel(label) {
  const value = String(label ?? '').trim().toUpperCase();
  const map = {
    BRIGHT_BAR: 'BRIGHT_BAR',
    '明るいバー': 'BRIGHT_BAR',
    SLIDE_PLUS_ONE: 'SLIDE_PLUS_ONE',
    'スライド+1': 'SLIDE_PLUS_ONE',
    MIRROR: 'MIRROR',
    '全反転': 'MIRROR',
  };

  return map[value] ?? null;
}

function formatSubmitSelection(list, formatter) {
  if (!list.length) {
    return 'なし';
  }

  return [...new Set(list)].map((item) => formatter(item)).join(', ');
}

function formatAchievementLabel(label) {
  const map = {
    SSS: 'SSS',
    'SSS+': 'SSS+',
    SCORE_1008500: '100.8500+',
    FC: 'FC',
    'FC+': 'FC+',
    AP: 'AP',
    'AP+': 'AP+',
    STAR4: '星4',
    STAR5: '星5',
    SAME4: '下4桁ゾロ目',
  };

  return map[label] ?? label;
}

function formatSpecialOptionLabel(label) {
  const map = {
    BRIGHT_BAR: '明るいバー',
    SLIDE_PLUS_ONE: 'スライド+1',
    MIRROR: '全反転',
  };

  return map[label] ?? label;
}

async function fetchOtogeDbSongs() {
  let lastError = null;

  for (const url of OTOGE_DB_SONG_URLS) {
    try {
      const response = await fetch(url, {
        headers: {
          accept: 'application/json,text/plain;q=0.9,*/*;q=0.8',
          'user-agent': 'TKPoint-management-systems/1.0',
        },
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

  throw lastError ?? new Error('failed to fetch OTOGE DB songs');
}

function normalizeOtogeSong(song) {
  const songId = String(song?.sort ?? '').trim();
  const title = String(song?.title ?? '').trim();
  const artist = String(song?.artist ?? '').trim();
  const versionCode = String(song?.version ?? '').trim();

  if (!songId || !title || !artist || !versionCode) {
    return null;
  }

  const charts = SONG_DIFFICULTY_FIELD_MAP.flatMap(({ field, chartSet, difficulty }) => {
    const level = String(song?.[field] ?? '').trim();
    if (!level) return [];

    return [
      {
        chartSet,
        difficulty,
        level,
        levelValue: parseLevelValue(level),
      },
    ];
  });

  if (charts.length === 0) {
    return null;
  }

  return {
    songId,
    title,
    artist,
    version: formatMaimaiVersion(versionCode),
    chartType: deriveChartType(charts),
    charts,
  };
}

function parseLevelValue(level) {
  const match = String(level ?? '').match(/\d+/);
  return match ? Number(match[0]) : null;
}

function deriveChartType(charts) {
  const sets = new Set(charts.map((chart) => chart.chartSet));
  const hasStd = sets.has('STD');
  const hasDx = sets.has('DX');

  if (hasStd && hasDx) return 'STD/DX';
  if (hasDx) return 'DX';
  if (hasStd) return 'STD';
  if (sets.has('UTAGE')) return 'UTAGE';
  return 'UNKNOWN';
}

function isValidOmikuziLevel(level) {
  return new Set([
    '1', '2', '3', '4', '5', '6', '7', '7+', '8', '8+', '9', '9+', '10', '10+',
    '11', '11+', '12', '12+', '13', '13+', '14', '14+', '15',
  ]).has(String(level ?? '').trim());
}

function formatMaimaiVersion(versionCode) {
  const code = Number(versionCode);
  if (!Number.isFinite(code)) {
    return versionCode;
  }

  const versionMap = [
    [26500, 'CiRCLE'],
    [26000, 'PRiSM PLUS'],
    [25500, 'PRiSM'],
    [25000, 'BUDDiES PLUS'],
    [24500, 'BUDDiES'],
    [24000, 'FESTiVAL PLUS'],
    [23500, 'FESTiVAL'],
    [23000, 'UNiVERSE PLUS'],
    [22500, 'UNiVERSE'],
    [22000, 'Splash PLUS'],
    [21500, 'Splash'],
    [21000, 'でらっくす PLUS'],
    [20500, 'でらっくす'],
    [20000, 'FiNALE'],
    [19500, 'MiLK PLUS'],
    [19000, 'MiLK'],
    [18500, 'MURASAKi PLUS'],
    [18000, 'MURASAKi'],
    [17000, 'PiNK PLUS'],
    [16000, 'PiNK'],
    [15000, 'ORANGE PLUS'],
    [14000, 'ORANGE'],
    [13000, 'GreeN PLUS'],
    [12000, 'GreeN'],
    [11000, 'maimai PLUS'],
    [10000, 'maimai'],
  ];

  for (const [threshold, label] of versionMap) {
    if (code >= threshold) {
      return label;
    }
  }

  return versionCode;
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

function deferredInteractionResponse(content, ephemeral = false) {
  return jsonResponse({
    type: DISCORD_RESPONSE_TYPE.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
    data: {
      ...(content ? { content } : {}),
      ...(ephemeral ? { flags: EPHEMERAL_FLAG } : {}),
    },
  });
}

async function sendInteractionFollowup(interaction, content) {
  const applicationId = interaction.application_id;
  const interactionToken = interaction.token;
  if (!applicationId || !interactionToken) {
    return;
  }

  await fetch(`https://discord.com/api/v10/webhooks/${applicationId}/${interactionToken}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json; charset=UTF-8',
    },
    body: JSON.stringify({ content }),
  });
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
