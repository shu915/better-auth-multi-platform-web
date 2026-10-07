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
- `/profile`(Server Component、閲覧のみ): email と name は自分のセッションから、bio は Go の `GET /me/profile` から取って表示し、Edit ボタンで `/profile/edit` に移る。JWT は `callApi` が発行する(ブラウザには出さない)。API が落ちていても、email と name は表示し、bio の欄にだけエラーを出す
- `/profile/edit`(Server Component): name と bio の編集フォーム(`src/components/profile-form.tsx`)と Cancel リンク(`/profile` に戻る)。API が落ちていても、name は保存できる(bio 欄は出さないので、空で上書きされない)。保存後は、失敗したフィールドがなければ `/profile` に移り、一部でも失敗したら `/profile/edit` に残してフィールドごとに結果を出す(判定は `shouldLeaveEditPage`)
- プロフィールの保存: Server Action `updateProfile`(`src/app/profile/actions.ts`)が、セッションを確認し、変更したフィールドだけを書く。name は Better Auth の `updateUser`(Web の DB)、bio は `callApi` で Go の `PUT /me/profile`。2 つの DB にまたがるのでトランザクションはなく、書き込みは独立に実行して結果をフィールドごとに表示する(どちらも冪等なので、再送すれば直る)。検証と書き込みのロジックは `src/lib/profile-form.ts`(単体テストあり)
- メール送信: `EMAIL_TRANSPORT` で `resend`(Resend で送信)か `console`(ログ出力)を選ぶ。本番では必須、開発は未設定なら `console`(`src/lib/email.ts`)

## コマンド
- `npm run dev`: 開発サーバー(localhost:3000)
- `npm run build`: ビルド
- `npm run lint`: lint
- 型チェック: `npx next typegen && npx tsc --noEmit`。`LayoutProps` などのグローバル型は `next typegen` が `.next/types` に生成するので、`.next` を消した後は先に typegen が要る(CI と Stop hook も同じ順序)
- `.next/` はビルド/dev のキャッシュ(gitignore 済み)。壊れたら消してよい
- 依存を足したり更新したりして `package-lock.json` が変わったら、`@rolldown/binding-*` が 15 個残っているか確認する(`grep -c '"node_modules/@rolldown/binding-' package-lock.json`)。0 なら npm の不具合で消えており、`npm test` が `Cannot find native binding` で落ちる(CI の Linux でも同じ)。`rm -rf node_modules package-lock.json && npm install` で作り直す
- `npm test`: テスト(Vitest。`src/**/*.test.ts`。ロジックだけを対象にし、画面と E2E はまだ対象外)
- `npm run db:generate`: マイグレーションファイルを生成(`drizzle/`)
- `npm run db:migrate`: マイグレーションを DB に適用(`DATABASE_URL_UNPOOLED` を使う)
- `npm run db:studio`: DB の中身を見る(Drizzle Studio)
- `npm run db:schema`: Better Auth の設定から `src/db/schema.ts` を再生成(手で編集しない)

## 型の方針
- `strict: true` を前提にする。`any` は使わない(`@typescript-eslint/no-explicit-any` が lint で止める)
- 型は、書くか推論に任せる。型を黙らせるための回避は使わない: `as unknown as X`、`@ts-ignore`、`@ts-expect-error`、`eslint-disable`
- 外部から来るデータ(Go API のレスポンス、フォーム入力、Cookie、環境変数)は `unknown` で受け、検証してから型を付ける。型を宣言するだけで信用しない
- 型の回避がどうしても必要なときは、理由を 1 行のコメントで書く。理由のない回避は `evaluator` が指摘する

## 実装後の流れ(生成と評価のループ)
実装は自分(ジェネレーター)、評価は `evaluator` エージェント(`.claude/agents/evaluator.md`)が行う。
1. 実装する。`npx tsc --noEmit`・`npm run lint`・`npm test` は hooks(`.claude/settings.json`)が自動で実行する(編集ごとに ESLint、応答終了時に tsc・lint・test)。失敗したら差し戻されるので直す。`npm run build` は hooks の対象外
2. `evaluator` を呼ぶ(ビルド確認とレビュー担当。挙動を変える変更のとき。ドキュメントやコメントだけの変更では呼ばない)
3. 判定が「要修正」なら、「高」「中」の指摘を直して 2 に戻る。ただし最大 5 周まで(これは打ち切りの上限で、普通はもっと少ない周回で終わる)
4. 「合格」になったら終了し、結果を報告する。5 周で合格しなければ、止めて残っている指摘をそのまま報告する(無理に通さない)。同じ指摘が再発したときは、上限を待たずに止めて報告する
5. 報告には、検証していない範囲(`npm run build` が環境変数不足で通せなかった、画面と E2E のテストがない、など)を必ず書く

### 人間の確認はループの外
- 画面の動作確認、手動テスト、最終レビューは人間の作業。ループの終了条件に含めない
- ループが終わる条件は「検証がすべて通り、evaluator が合格」(または最大 5 周で打ち切り)だけ
- 終了時の報告に、人間向けの確認手順と、AI が検証していない範囲を書く。人間の返事は待たない
- 人間が問題を見つけたら、その内容を起点に新しい goal として回す
- goal を書くときは、完了条件(AI がループ内で満たす。機械で確認できるものだけ)と、ループの外(人間の作業)の節を分ける

### テストを通すための改ざんは禁止
合格させるために、次をしてはいけない。やむを得ず変えるときは、理由を報告に書き、人間の確認を待つ。
- 失敗するテストの削除、`it.skip` / `test.skip` / `.only` の追加、`exclude` で外すこと
- 期待値やアサーションを、実装の出力に合わせて弱める・書き換えること(仕様が変わった場合を除く)
- 型や lint を黙らせる回避(「型の方針」で禁止したもの)を足すこと、tsconfig や ESLint のルールを緩めること
- 検証用の値(タイムアウト、上限値、許可リストなど)を、通るように緩めること
- `evaluator` の指摘を、直さずにコメントや設定で黙らせること
テストが落ちたら、まず実装が間違っていると考える。テストの側が間違っていると判断するときも、その根拠を書く。

### コミットとマイグレーション
- 人が頼むまでコミットしない(変更は未コミットで残し、先に読んでもらう)
- `npm run db:migrate` は実行しない。`npm run db:schema` で `src/db/schema.ts` を再生成するのも、頼まれたときだけにする(手順を案内する)
- `.env` 系のファイルは読まない

### hooks が強制していること(`.claude/hooks/`)
- PreToolUse でブロック: `.env` 系の読み取り(`.env.example` は可)、`git commit/push/clean/reset --hard`、`rm -r`、`db:migrate` / `db:schema` / `drizzle-kit migrate|push`、`drizzle/`・`src/db/schema.ts`・`package-lock.json`・`.github/workflows/` の編集、`@ts-ignore` / `eslint-disable` / `as unknown as` / `any` の追加、テストや設定への `skip` / `only` / `strict:false` / ルール `off` / `exclude`
- ブロックされたら回避せず、理由を報告して人の指示を待つ

## 公開前チェックリスト
- レート制限の保存先を DB にする(`rateLimit: { storage: "database" }`)
- `pg` の Pool を `globalThis` にキャッシュし、`max` と `error` ハンドラを入れる
- `trustedOrigins` を設定する(Tauri / Expo など、別のオリジンのクライアントを足すとき)
- サインアップを制限するか決める(`disableSignUp`)
- メール HTML の URL をエスケープする
- Better Auth に `cookieCache` を入れるなら、`updateProfile` の `currentName: session.user.name`(セッションの名前との比較)をやめ、bio と同じく `initialName` の hidden 値と比べる(セッションが古い名前を返すと、A→B→A と戻した保存が「変更なし」と判定されて DB に書かれない)

## 進捗ファイル
- `claude-progress.txt` に、完了・実行中・これからのタスクを書く。新しいセッションは、最初にこのファイルと CLAUDE.md を読む
- goal が終わるたびに(ループの終了時の報告と一緒に)更新する。長いセッションで文脈が劣化しても、続きから始められるようにするため
