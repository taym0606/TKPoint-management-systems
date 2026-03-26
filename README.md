# TKPoint Discord Bot (Cloudflare Workers + D1)

Discord Interaction API (Webhook) を使う Bot 実装です。

## セットアップ

1. D1 作成
2. `wrangler.toml` の `database_id` を設定
3. スキーマ適用

```bash
wrangler d1 execute tkpoint-db --file=schema.sql
```

4. シークレット設定

```bash
wrangler secret put DISCORD_PUBLIC_KEY 303c432497ac86bb23828d4d2a3f71b708cefcfc7d329e01bf4f955400b7de8e
wrangler secret put ADMIN_ROLE_ID
```

5. デプロイ

```bash
wrangler deploy
```

## 実装コマンド

- `/pt`
- `/submit score`
- `/battle @user`
- `/startbattle amount`
- `/result win|lose`
- `/approve requestId` (管理者)
- `/reject requestId` (管理者)
- `/ranking`
- `/convert amount`

## 注意

- すべての計算ロジックは Worker 側で実行
- 申請は `requests` に `pending` で積み、管理者が承認
- 対戦クールタイムは 3 日
- 変換は月 10pt まで
