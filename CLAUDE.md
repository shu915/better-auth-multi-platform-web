@AGENTS.md

# better-auth-multi-platform-web

## 概要
Next.js と Better Auth、Go で認証を実装する。
Go の API は別リポジトリ(`better-auth-multi-platform-api`)。
将来は Tauri(デスクトップ)と Expo(モバイル)からも、同じサービスに組み込む。
認証は Next.js の Better Auth が担当する。クライアント(Web / Tauri / Expo)はそこでログインし、
JWT を取得して Go の API を直接呼ぶ(Next.js はデータの中継をしない)。
ログイン方法はマジックリンクを必須とし、OAuth は任意で有効にできる。パスワードは使わない。

## 使用技術
- Next.js 16(App Router)/ React 19 / TypeScript
- Tailwind CSS v4
- Better Auth(認証)
- Drizzle + Neon(Postgres)
- Go API とは JWT で連携(Go は JWKS で署名を検証)
- メール送信: `EMAIL_TRANSPORT` で `resend`(Resend で送信)か `console`(ログ出力)を選ぶ。本番では必須、開発は未設定なら `console`(`src/lib/email.ts`)

## コマンド
- `npm run dev`: 開発サーバー(localhost:3000)
- `npm run build`: ビルド
- `npm run lint`: lint
- `npm test`: テスト(Vitest。`src/**/*.test.ts`。ロジックだけを対象にし、画面と E2E はまだ対象外)
- `npm run db:generate`: マイグレーションファイルを生成(`drizzle/`)
- `npm run db:migrate`: マイグレーションを DB に適用(`DATABASE_URL_UNPOOLED` を使う)
- `npm run db:studio`: DB の中身を見る(Drizzle Studio)
- `npm run db:schema`: Better Auth の設定から `src/db/schema.ts` を再生成(手で編集しない)

## 公開前チェックリスト
- レート制限の保存先を DB にする(`rateLimit: { storage: "database" }`)
- JWT の payload を `definePayload` で最小化し、`issuer` と `audience` を Go 側の検証と合わせる
- `pg` の Pool を `globalThis` にキャッシュし、`max` と `error` ハンドラを入れる
- `trustedOrigins` を設定する(Tauri / Expo を足すとき)
- サインアップを制限するか決める(`disableSignUp`)
- メール HTML の URL をエスケープする
