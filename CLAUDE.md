@AGENTS.md

# better-auth-multi-platform-web

## 概要
Next.js と Better Auth、Go で認証を実装する。
Go の API は別リポジトリ(`better-auth-multi-platform-api`)。
将来は Tauri(デスクトップ)と Expo(モバイル)からも、同じ Go のサービスを使う予定(おいおい実装する。今は Web のみ)。
認証は Next.js の Better Auth が担当する。Web は Next.js のサーバー(BFF)経由で Go を呼ぶ。
サーバーが、呼ぶたびに JWT を発行して付ける(`src/lib/api-server.ts` の `callApi`)。ブラウザには JWT を出さず、フォームも Server Action 経由にする。
Go は JWT を検証するだけで、呼び出し元を区別しない。そのため、Tauri / Expo は、Better Auth でログインして JWT を取得し、Go を直接呼ぶ形で足せる(Go は変えずに済む)。
ログイン方法はマジックリンクを必須とし、OAuth は任意で有効にできる。パスワードは使わない。

## 使用技術
- Next.js 16(App Router)/ React 19 / TypeScript
- Tailwind CSS v4
- Better Auth(認証)
- Drizzle + Neon(Postgres)
- Go API とは JWT で連携(Go は JWKS で署名を検証)
- Go API の呼び出し: `src/lib/api.ts` の `apiRequest`(トークンを受け取る低レベルの関数)と、`src/lib/api-server.ts` の `callApi` / `getMyProfile`(サーバー用。JWT を自分で発行する)。JWT は `Authorization: Bearer` で渡す。ベース URL は `API_BASE_URL`(開発は未設定なら `http://localhost:8080`、本番では必須)。5 秒でタイムアウトする
- `/profile`(Server Component): email と name は自分のセッションから、bio は Go の `GET /me/profile` から取る。JWT は `callApi` が発行する(ブラウザには出さない)。API が落ちていても、email と name は表示し、bio の欄にだけエラーを出す
- メール送信: `EMAIL_TRANSPORT` で `resend`(Resend で送信)か `console`(ログ出力)を選ぶ。本番では必須、開発は未設定なら `console`(`src/lib/email.ts`)

## コマンド
- `npm run dev`: 開発サーバー(localhost:3000)
- `npm run build`: ビルド
- `npm run lint`: lint
- 依存を足したり更新したりして `package-lock.json` が変わったら、`@rolldown/binding-*` が 15 個残っているか確認する(`grep -c '"node_modules/@rolldown/binding-' package-lock.json`)。0 なら npm の不具合で消えており、`npm test` が `Cannot find native binding` で落ちる(CI の Linux でも同じ)。`rm -rf node_modules package-lock.json && npm install` で作り直す
- `npm test`: テスト(Vitest。`src/**/*.test.ts`。ロジックだけを対象にし、画面と E2E はまだ対象外)
- `npm run db:generate`: マイグレーションファイルを生成(`drizzle/`)
- `npm run db:migrate`: マイグレーションを DB に適用(`DATABASE_URL_UNPOOLED` を使う)
- `npm run db:studio`: DB の中身を見る(Drizzle Studio)
- `npm run db:schema`: Better Auth の設定から `src/db/schema.ts` を再生成(手で編集しない)

## 公開前チェックリスト
- レート制限の保存先を DB にする(`rateLimit: { storage: "database" }`)
- JWT の payload を `definePayload` で最小化し、`issuer` と `audience` を Go 側の検証と合わせる
- `pg` の Pool を `globalThis` にキャッシュし、`max` と `error` ハンドラを入れる
- `trustedOrigins` を設定する(Tauri / Expo など、別のオリジンのクライアントを足すとき)
- サインアップを制限するか決める(`disableSignUp`)
- メール HTML の URL をエスケープする
