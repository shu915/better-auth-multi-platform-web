@AGENTS.md

# better-auth-multi-platform-web

## 概要
Next.js と Better Auth、Go で認証を実装する。Go の API は別リポジトリ(`better-auth-multi-platform-api`)。将来は Tauri(デスクトップ)と Expo(モバイル)からも同じ Go を使う予定(今は Web のみ)。
- 認証は Next.js の Better Auth が担当する。Web は Next.js のサーバー(BFF)経由で Go を呼ぶ。サーバーが、呼ぶたびに JWT を発行して付ける(`src/lib/api-server.ts` の `callApi`)。ブラウザには JWT を出さず、フォームも Server Action 経由にする
- Go は JWT(JWKS で署名を検証)を検証するだけで、呼び出し元を区別しない。だから Tauri / Expo は、Better Auth でログインして JWT を取り、Go を直接呼ぶ形で足せる(Go は変えずに済む)
- ログインはマジックリンクが必須(これが root で、ユーザー ID = JWT の `sub` が決まる)。Google などの OAuth は、ログイン済みのユーザーが後から足す任意の手段で、新規登録はできない。パスワードは使わない

## 使用技術
Next.js 16(App Router)/ React 19 / TypeScript / Tailwind CSS v4 / Better Auth / Drizzle + Neon(Postgres)

## 詳細ドキュメント(必要なときに読む)
- [docs/design.md](docs/design.md): DB 接続、CSP、Go API の呼び出し、プロフィール、Google ログイン、退会、メール送信、レート制限の方針と理由
- [docs/deploy.md](docs/deploy.md): デプロイ先(Vercel + Neon、Render)、レート制限テーブルの手順、公開前チェックリスト
- 次の機能を触るときは、先に該当の節を読む。コードを変えたら、その節も直す

## 守るルール(特に壊しやすいもの)
- JWT をブラウザに出さない。Go を呼ぶのは `callApi`(サーバー)だけ
- `/api/auth/delete-user`・`/update-user`・`/token` などは HTTP では 403 `SERVER_ONLY`(`google-auth-options.ts` の `hooks.before`)。Cookie だけで Server Action のチェックを素通りさせないため。デスクトップやモバイルが Go を直接呼ぶ構成にするときは見直す
- 紐づけ・解除・退会は「5 分以内のログイン」(`FRESH_SESSION_SECONDS`)を要求する
- **静的なページ(セッションを読まないページ)を足すと CSP の nonce が付かず止まる。** 足したら本番ビルドを手元で起動して確かめる(E2E は開発サーバーなので捕まえられない)。詳細は docs/design.md
- 本番の `EMAIL_TRANSPORT` は `resend` だけ。本番の `DATABASE_URL` は `sslmode=require` 以上

## コマンド
- `npm run dev`: 開発サーバー(localhost:3000)/ `npm run build` / `npm run lint`
- 型チェック: `npx next typegen && npx tsc --noEmit`(`.next` を消した後は先に typegen が要る。CI と Stop hook も同じ順序)
- `npm test`: Vitest(`src/**/*.test.ts`。画面のテストは入れない方針)
  - `src/lib/auth-postgres.test.ts` は実 Postgres を使う。`TEST_DATABASE_URL` が要る(`api/` で `docker compose up -d db` を起動しておけば Stop hook が渡す。CI は service を立てる)。**本物のデータが入った DB を指さない**。未設定だと SKIP され、CI は SKIP があると失敗する
- `npm run test:e2e`: E2E(Playwright。ログイン → プロフィール編集 → 退会の 1 本)。Postgres(`api/` で `docker compose up -d db`)、Go(`../api`、`API_DIR` で変更)、`npx playwright install chromium`(初回)が要る。実行のたびに `e2e_web` と `e2e_api` を作り直すので、**本物のデータが入った Postgres を `E2E_DATABASE_URL` に指さない**。開発サーバーで動くので、本番ビルドだけの挙動(レート制限、Cookie の Secure、`file` メール転送の拒否)は通らない。ポート 3100 と 8180 を使う。`npx playwright test` は直接実行しない
- `npm run db:generate`: マイグレーションを生成(`drizzle/`)/ `npm run db:migrate`: 適用(`DATABASE_URL_UNPOOLED`)/ `npm run db:studio` / `npm run db:schema`: Better Auth の設定から `src/db/schema.ts` を再生成(手で編集しない)
- `.next/` は壊れたら消してよい

## 依存を足すときの注意(npm の不具合)
macOS で `npm install` すると、`package-lock.json` から `@rolldown/binding-*` が消えることがある。`grep -c '"node_modules/@rolldown/binding-' package-lock.json` が 15 でなく 0 なら、`npm test` が `Cannot find native binding` で落ちる(CI の Linux でも同じ)。
- `rm -rf node_modules package-lock.json && npm install` で作り直す
- hook が `rm -r` を止めるときは、**空の一時フォルダに `package.json` だけをコピーし、lock なしで `npm install --package-lock-only` した lock を取り込む**(15 件になる)。そのあと `npm install` はもう一度実行せず、`npm ci` で入れ直す

## 型の方針
- `strict: true` を前提にする。`any` は使わない(`@typescript-eslint/no-explicit-any` が lint で止める)
- 型は書くか推論に任せる。黙らせる回避は使わない: `as unknown as X`、`@ts-ignore`、`@ts-expect-error`、`eslint-disable`
- 外部から来るデータ(Go のレスポンス、フォーム入力、Cookie、環境変数)は `unknown` で受け、検証してから型を付ける
- どうしても回避が要るときは、理由を 1 行のコメントで書く。理由のない回避は `evaluator` が指摘する

## 実装後の流れ(生成と評価のループ)
実装は自分、評価は `evaluator` エージェント(`.claude/agents/evaluator.md`)。
1. 実装する。tsc・lint・test は hooks(`.claude/settings.json`)が自動で実行する(編集ごとに ESLint、応答終了時に tsc・lint・test)。失敗したら差し戻されるので直す。`npm run build` は hooks の対象外
2. 挙動を変える変更のときは `evaluator` を呼ぶ(ドキュメントやコメントだけの変更では呼ばない)
3. 「要修正」なら「高」「中」の指摘を直して 2 に戻る。最大 5 周で打ち切る
4. 「合格」で終了し、結果を報告する。5 周で合格しなければ、止めて残りの指摘をそのまま報告する(無理に通さない)。同じ指摘が再発したら、上限を待たずに止める
5. 報告には、検証していない範囲(ビルドが環境変数不足で通せなかった、画面のテストがない、など)と、人間向けの確認手順を必ず書く。人間の返事は待たない

人間の確認(画面の動作確認、手動テスト、最終レビュー)はループの外。人間が問題を見つけたら、その内容を新しい goal として回す。goal を書くときは、完了条件(機械で確認できるもの)と、ループの外(人間の作業)を分ける。

### テストを通すための改ざんは禁止
やむを得ず変えるときは、理由を報告に書き、人間の確認を待つ。
- 失敗するテストの削除、`skip` / `only` の追加、`exclude` で外すこと
- 期待値を実装の出力に合わせて弱めること(仕様が変わった場合を除く)
- 型や lint を黙らせる回避を足すこと、tsconfig や ESLint のルールを緩めること
- タイムアウト、上限値、許可リストなどを、通るように緩めること
- `evaluator` の指摘を、直さずにコメントや設定で黙らせること

テストが落ちたら、まず実装が間違っていると考える。テストの側が間違っていると判断するときも、根拠を書く。

## コミットと hooks
- 人が頼むまでコミットしない(未コミットで残し、先に読んでもらう)。push は hook が止めるので人が実行する。`.github/workflows/` の編集は hook では止めない。CI を緩める変更(テストの削除、SKIP を許す、など)は改ざんとして扱う
- `npm run db:migrate` は実行しない。`npm run db:schema` も、頼まれたときだけ(手順は docs/deploy.md)
- `.env` 系のファイルは読まない
- PreToolUse でブロック(`.claude/hooks/`): `.env` 系の読み取り(`.env.example` は可)、`git push/clean/reset --hard`、`rm -r`、`db:migrate` / `db:schema` / `drizzle-kit migrate|push`、`drizzle/`・`src/db/schema.ts`・`package-lock.json` の編集、`@ts-ignore` / `eslint-disable` / `as unknown as` / `any` の追加、テストや設定への `skip` / `only` / `strict:false` / ルール `off` / `exclude`
- ブロックされたら回避せず、理由を報告して人の指示を待つ

## 進捗ファイル
- `claude-progress.txt` に、完了・実行中・これからのタスクを書く。新しいセッションは、最初にこのファイルと CLAUDE.md を読む
- goal が終わるたびに、終了時の報告と一緒に更新する
- PR を作るとき(頼まれたとき)は、PR の前に書き直す: 完了を移し、「実行中」を現状に合わせ、「これから」の先頭を次の作業にする。同じ PR に入れる
