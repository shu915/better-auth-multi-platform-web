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
- DB 接続(`src/lib/db.ts` と `src/lib/database-config.ts`): 本番(`NODE_ENV=production`)では、`DATABASE_URL` に `sslmode=require`(または `verify-ca` / `verify-full`)がないと起動時にエラー(Go と同じ。`next build` の間は検査しない。ビルドはダミーの設定で、接続しないため)。開発は強制しない。プールは `globalThis` に 1 つだけ作り(ホットリロードで増えない)、最大 10 接続(`DATABASE_POOL_MAX` で 1〜50 に変更)、接続待ち 5 秒、クエリ 10 秒(クライアント側の `query_timeout`。サーバー側の `statement_timeout` を起動パラメータで送ると、Neon の pooled URL などが拒否する恐れがあるため使わない)、アイドル接続のエラーはログに出す。`DATABASE_URL_UNPOOLED` は `drizzle-kit` 専用(`-pooler` の付かない、直接つなぐ URL にする。プール経由だとマイグレーションが固まる)
- CSP(Content-Security-Policy。`src/proxy.ts` と `src/lib/csp.ts`): ページへのリクエストごとに、新しい合言葉(nonce)を作り、「合言葉の付いた自分たちのスクリプトだけ実行してよい」というポリシーをヘッダーで返す(Next.js は、リクエストのヘッダーから合言葉を拾って、自分のスクリプトに付ける)。`unsafe-inline` は使わない。`unsafe-eval` は開発だけ(React が開発でのみ使う)。`frame-ancestors 'none'`、`object-src 'none'` なども付く。**今は `Content-Security-Policy-Report-Only`(違反を報告するだけで止めない)**。ページを毎回描画する必要がある(全ページがセッションを読むので満たしている)。API のルート、静的ファイル、先読みには付けない。E2E が、ヘッダーの合言葉がページのスクリプトに付いていることと、違反の報告が一つも出ないことを確かめる
- Go API の呼び出し: `src/lib/api.ts` の `apiRequest`(トークンを受け取る低レベルの関数)と、`src/lib/api-server.ts` の `callApi` / `getMyProfile`(サーバー用。JWT を自分で発行する)。JWT は `Authorization: Bearer` で渡す。ベース URL は `API_BASE_URL`(開発は未設定なら `http://localhost:8080`、本番では必須)。5 秒でタイムアウトする
- `/profile`(Server Component、閲覧のみ): email と name は自分のセッションから、bio は Go の `GET /me/profile` から取って表示し、Edit ボタンで `/profile/edit` に移る。JWT は `callApi` が発行する(ブラウザには出さない)。API が落ちていても、email と name は表示し、bio の欄にだけエラーを出す
- `/profile/edit`(Server Component): name と bio の編集フォーム(`src/components/profile-form.tsx`)と Cancel リンク(`/profile` に戻る)。API が落ちていても、name は保存できる(bio 欄は出さないので、空で上書きされない)。保存後は、失敗したフィールドがなければ `/profile` に移り、一部でも失敗したら `/profile/edit` に残してフィールドごとに結果を出す(判定は `shouldLeaveEditPage`)
- プロフィールの保存: Server Action `updateProfile`(`src/app/profile/actions.ts`)が、セッションを確認し、変更したフィールドだけを書く。name は Better Auth の `updateUser`(Web の DB)、bio は `callApi` で Go の `PUT /me/profile`。2 つの DB にまたがるのでトランザクションはなく、書き込みは独立に実行して結果をフィールドごとに表示する(どちらも冪等なので、再送すれば直る)。検証と書き込みのロジックは `src/lib/profile-form.ts`(単体テストあり)
- ログインの設計: ユーザーはマジックリンクで作られる(これが root。ユーザー ID = JWT の `sub` がここで決まる)。Google などは、ログイン済みのユーザーが後から足す**任意のログイン手段**で、ユーザーを新しく作ることはできない
- Google ログイン(任意): `GOOGLE_CLIENT_ID` と `GOOGLE_CLIENT_SECRET` を**両方**設定すると有効になる(未設定なら無効で、マジックリンクだけ。片方だけだと起動時にエラー。判定は `src/lib/google-oauth.ts` の `resolveGoogleCredentials`)。Google Cloud Console の承認済みリダイレクト URI は `<BETTER_AUTH_URL>/api/auth/callback/google`
  - ログインの方針は `src/lib/google-auth-options.ts` の `googleAuthOptions` にあり、`auth.ts` が使う: `google.disableSignUp: true`(Google では新規登録できない)、`accountLinking.disableImplicitLinking: true`(同じメールでも自動では紐づけない)、`allowDifferentEmails: true`(Google のメールが root と違ってもよい。紐づけにはログイン中のセッションが要る。Better Auth は、セッションなしで紐づけられる経路があるとアカウント乗っ取りになりうると警告している)、`allowUnlinkingAll: true`
  - 方針のテスト: `src/lib/google-auth.test.ts` が、本物の Better Auth をメモリ上の DB(`better-auth/adapters/memory`)で動かし、Google のトークン交換(`fetch`)だけを偽物にして、新規登録できない、未紐づけは(同じメールでも)入れない、紐づけると同じユーザーで入れる、解除すると入れない、他人に紐づいた Google は紐づけられない、セッションなしでは紐づけを始められない、を確かめる。設定を壊すと落ちることを確認済み。画面と、実際の Google との往復は対象外
  - セッションを盗まれた場合の対策(`google-auth-options.ts`): セッションを盗んだ人が自分の Google を紐づけると、盗んだセッションが切れた後も入れてしまう。そこで、(1) 紐づけ(`/link-social`)にも、解除と同じ「新しいログイン」を要求する。`hooks.before` で、ログインから `FRESH_SESSION_SECONDS`(5 分。Better Auth の既定は 1 日)を過ぎていたら `SESSION_NOT_FRESH`(403)で断る。この値は、新しさを求める他の操作にも効く。(2) 紐づけの行ができたら(`databaseHooks.account.create.after`)、Google のメールではなく、**root のメールアドレス**に知らせる(`src/lib/linked-accounts.ts` の `linkedAccountEmail`。送信は `auth.ts` の `notifyLinked`。失敗しても紐づけは成功する)。画面は、断られたときに「ホームでサインアウト → メールリンクで入り直す → もう一度」と案内する
  - 残る弱点: 5 分以内に盗まれたセッションは、紐づけられてしまう。メールの通知で気づくのが、最後の手段。さらに強くするなら、紐づけの前に、root のメールへ確認リンクを送る方式がある(未実装)
  - 紐づけ: `/profile` の「Other ways to sign in」で、ログイン済みのユーザーが「Link Google」(`authClient.linkSocial`、`src/components/link-google-button.tsx`)。紐づけ済みなら「Google: linked」と出る。有効なときだけ表示する(`googleEnabled`)
  - ログイン: `/login` の「Continue with Google」は、紐づけ済みの Google アカウントだけが入れる。未紐づけだと `/login?error=...` に戻り、`src/lib/oauth-errors.ts` の `oauthErrorMessage` が既知のコード(`signup_disabled`、`account_not_linked` など)だけ文言に変える(未知のコードは汎用の文言で、クエリをそのまま出さない)
  - 紐づけたユーザーでログインすれば、`sub` は root のままなので、Go の `profiles` はそのまま使える。Go は変えない
  - 解除: 紐づけ済みなら、`/profile` の「Google: linked」の横に「Unlink Google」(`authClient.unlinkAccount`、`src/components/unlink-google-button.tsx`)。マジックリンクは常に使えて、`account` の行がなくても困らないので、`allowUnlinkingAll: true` にしてある(これがないと、最後の 1 行は解除できない)。解除にも、紐づけと同じく最近のログイン(5 分以内)が要る(`SESSION_NOT_FRESH` のときは、ログインし直すよう案内する。文言は `src/lib/linked-accounts.ts`)
  - 1 人のユーザーに紐づく Google は、画面からは 1 つだけ(紐づけ済みなら「Link Google」を隠す)。1 つの Google アカウントを複数のユーザーに紐づけることは、Better Auth が止める
  - 未対応: 他のプロバイダ(今は Google だけ)
- 退会(`/profile` の「Delete account」、`src/components/delete-account-form.tsx`): Server Action `deleteMyAccount`(`src/app/profile/actions.ts`)が `src/lib/delete-account.ts` の `deleteAccount` を呼ぶ。順序は (1) `revokeOtherSessions`(新しい JWT が出なくなる)→ (2) Go の `DELETE /me`(冪等、204)→ (3) Better Auth の `deleteUser`(user を消すと、session と account=Google の紐づけも DB の外部キー cascade と Better Auth で消える)。どこかで失敗したらそこで止まり、ユーザーは残る。再送すれば全部やり直せる。成功したら、root のメールに「退会した」通知を送る(`notifyDeleted`。宛先は `deleteAccount` がセッションのメールに決める。入力した確認用メールではない。送信は `after()` で非同期、失敗しても退会は成功のまま。盗まれたセッションでの退会に本人が気づくため)。入力した確認用メールが一致しないと何も呼ばない。`deleteUser` は新しいログイン(`FRESH_SESSION_SECONDS`、5 分)を要求するが、Go のデータを消した後に断られると「データのないアカウント」が残るので、`deleteAccount` が最初に鮮度を確かめる。**退会とプロフィール更新は、HTTP 経由では拒否する。** Better Auth は `/api/auth/delete-user` と `/api/auth/update-user` も公開するが、確認用メール・Go のデータ削除・通知・名前の検証は Server Action にしかないため、Cookie だけで素通りできてしまう(実際に再現した)。`google-auth-options.ts` の `hooks.before` が、受信リクエストのある呼び出し(HTTP)だけ 403 `SERVER_ONLY` で断る。Server Action の `auth.api.*` はリクエストがないので通る。ブラウザ側のコードはこの 2 つを呼ばない。**`/api/auth/token`(JWT を返す)も同じ理由で HTTP 経由は拒否する**(Cookie だけで JWT を取れると、盗まれたセッションや画面上のスクリプトが、5 分の新しいログインの確認を通らずに Go の `DELETE /me` などを直接呼べるため)。`callApi` はサーバー内の `auth.api.getToken` を使うので影響しない。公開鍵の `/api/auth/jwks` は、Go が取りに来るので公開のまま。デスクトップやモバイルが Go を直接呼ぶ構成にするときは、このルールを見直す(専用のエンドポイントにする、など)。`sendDeleteAccountVerification` や `changeEmail` を有効にするときも、ここのガードとテスト(`/delete-user/callback` など)を見直す`user.deleteUser.enabled` は `google-auth-options.ts` にあり、`google-auth.test.ts` の「account deletion」が守る(無効にすると落ちることを確認済み)。Cookie を消すため `auth.ts` の plugins の最後に `nextCookies()` を入れてある。`apiRequest` は 204 を本文なしの成功として扱う
  - 退会後に残るもの(`deleteUser` が消すのは user、session、account だけ。Better Auth のソースで確認): `jwks` は全ユーザー共通の署名鍵で、個人のデータではない(消してはいけない)。`verification` には、まだ使っていないマジックリンクの行が残りうる(`value` に email が入る)。リンクの有効期限は既定で 5 分なので、退会後に残るのは最大 5 分分で、期限が切れたら無効になる。期限切れの行を定期的に掃除するのは、デプロイ時の運用(未実装)
- メール送信: `EMAIL_TRANSPORT` で `resend`(Resend で送信)か `console`(ログ出力)を選ぶ。本番では必須、開発は未設定なら `console`(`src/lib/email.ts`)

## コマンド
- `npm run dev`: 開発サーバー(localhost:3000)
- `npm run build`: ビルド
- `npm run lint`: lint
- 型チェック: `npx next typegen && npx tsc --noEmit`。`LayoutProps` などのグローバル型は `next typegen` が `.next/types` に生成するので、`.next` を消した後は先に typegen が要る(CI と Stop hook も同じ順序)
- `.next/` はビルド/dev のキャッシュ(gitignore 済み)。壊れたら消してよい
- 依存を足したり更新したりして `package-lock.json` が変わったら、`@rolldown/binding-*` が 15 個残っているか確認する(`grep -c '"node_modules/@rolldown/binding-' package-lock.json`)。0 なら npm の不具合で消えており、`npm test` が `Cannot find native binding` で落ちる(CI の Linux でも同じ)。`rm -rf node_modules package-lock.json && npm install` で作り直す
- `npm run test:e2e`: E2E(Playwright。画面から最後まで通す 1 本: マジックリンクでログイン → プロフィール編集 → 退会)。本物のブラウザ、Web(`next dev`、ポート 3100、出力先 `.next-e2e`)、Go(`go run`、ポート 8180)、Postgres を使う。自分の `npm run dev` は止めなくてよい。必要なもの: Postgres(`api/` で `docker compose up -d db`)、Go、`../api`(`API_DIR` で変更)、`npx playwright install chromium`(初回だけ)。実行のたびに `e2e_web` と `e2e_api` を作り直す(`e2e/prepare.mjs`)ので、**本物のデータが入った Postgres を `E2E_DATABASE_URL` に指さない**こと。マジックリンクは、`EMAIL_TRANSPORT=file`(本番では拒否される)で `e2e/.tmp/mail.jsonl` に書き出されたものをテストが読む。本物の Google は E2E に含めない(手動で確認する範囲)。**開発サーバー(`next dev`)で動かすので、本番ビルドだけで変わる挙動(Better Auth のレート制限、Cookie の Secure、`file` メール転送の拒否)は通らない**。ポート 3100 と 8180 が使用中だと起動に失敗する。`npx playwright test` を直接実行しない(DB の準備は `npm run test:e2e` の最初の手順)。CI では別ジョブ(`e2e`)で、api のリポジトリを checkout して動かす。`npm test`(Vitest)の対象にはならない
- `npm test`: テスト(Vitest。`src/**/*.test.ts`。画面のテストは入れない方針。E2E は下の `npm run test:e2e`)
  - `src/lib/auth-postgres.test.ts` は実 Postgres を使う。`TEST_DATABASE_URL` が要る(開発では `api/` で `docker compose up -d db` を起動しておけば、Stop hook が自動で渡す。CI は Postgres の service を立てる)。テストは専用のスキーマを作って、終わったら消す。**本物のデータが入った DB を指さない**こと(本番とは別のデータベースと別のロールを使う。プロセスが強制終了すると、`web_test_` で始まるスキーマが残ることがある)。未設定だと SKIP され、CI は SKIP があると失敗する
  - `src/lib/api-http.test.ts` は本物の HTTP サーバー(Go の応答を真似る)に対して `apiRequest` を確かめる。`src/app/profile/actions.test.ts` は Server Action の結線
- `npm run db:generate`: マイグレーションファイルを生成(`drizzle/`)
- `npm run db:migrate`: マイグレーションを DB に適用(`DATABASE_URL_UNPOOLED` を使う)
- `npm run db:studio`: DB の中身を見る(Drizzle Studio)
- `npm run db:schema`: Better Auth の設定から `src/db/schema.ts` を再生成(手で編集しない)

## 依存を足すときの注意(npm の不具合)
`npm install` を実行すると、macOS 上では `package-lock.json` から `@rolldown/binding-*` が消えることがある(`grep -c '"node_modules/@rolldown/binding-' package-lock.json` が 0 になる)。そのまま出すと、CI(Linux)で `npm test` が落ちる。hook は `rm -r` を止めるので、「node_modules と lock を消して作り直す」手順が使えないときは、**空の一時フォルダに `package.json` だけをコピーし、lock なしで `npm install --package-lock-only` して生成した lock を取り込む**(15 件になる。範囲内のパッチ更新が混ざる)。そのあと、`npm install` をもう一度実行せずに、`npm ci` で `node_modules` を lock のとおりに入れ直す(lock は書き換えない)。

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
- 人が頼むまでコミットしない(変更は未コミットで残し、先に読んでもらう)。hook はコミットを止めない(運用で守る)。push は hook が止めるので、人が実行する。`.github/workflows/` の編集は hook では止めない。CI を緩める変更(テストの削除、SKIP を許す、など)は、改ざんとして扱い、PR の差分で見る
- `npm run db:migrate` は実行しない。`npm run db:schema` で `src/db/schema.ts` を再生成するのも、頼まれたときだけにする(手順を案内する)
- `.env` 系のファイルは読まない

### hooks が強制していること(`.claude/hooks/`)
- PreToolUse でブロック: `.env` 系の読み取り(`.env.example` は可)、`git push/clean/reset --hard`(`git commit` はローカルで取り消せるのでブロックしない。コミットは頼まれたときだけ、という運用は変えない)、`rm -r`、`db:migrate` / `db:schema` / `drizzle-kit migrate|push`、`drizzle/`・`src/db/schema.ts`・`package-lock.json` の編集、`@ts-ignore` / `eslint-disable` / `as unknown as` / `any` の追加、テストや設定への `skip` / `only` / `strict:false` / ルール `off` / `exclude`
- ブロックされたら回避せず、理由を報告して人の指示を待つ

## レート制限の保存先を DB にする手順(人が実行する)
`auth.ts` は、Better Auth のレート制限を `storage: "database"` にしている(サーバーレスでは、メモリに数えても効かないため)。Better Auth は起動時に Drizzle のスキーマを検査し、`rateLimit` テーブルがないと **`Missing tables: rateLimit` でエラーになる**(開発サーバーも E2E も動かない)。次の順で、人が実行する(hook は、この 3 つを私が実行するのを止める):
1. `npm run db:schema`(`auth.ts` の設定から `src/db/schema.ts` を再生成する。`rateLimit` が足される)
2. `npm run db:generate`(`drizzle/` に、マイグレーションの SQL を作る)
3. `npm run db:migrate`(`.env.local` の `DATABASE_URL_UNPOOLED` が指す DB に適用する。**本番の Neon にも、デプロイの前に同じ SQL を適用する**。Vercel のプレビューが、本番とは別の Neon のブランチを指すなら、そちらにも。`rate_limit` テーブルがない DB では、Better Auth のレート制限の対象になる認証リクエストが失敗する。一方、自前の宛先ごとの制限は、数えられなければ通す(fail-open)ので、壊れても気づきにくい。古いコードに戻すときは、テーブルが残っていても害はない)

E2E と実 Postgres のテストは、`drizzle/` の SQL を直接流すので、2 のあとは追加の作業が要らない。

## デプロイ先
- Web: **Vercel + Neon**(サーバーレス)。API(Go)とその DB は **Render**。Go は、Vercel の https の JWKS(`<本番の URL>/api/auth/jwks`)を取りに来るので、Go の `AUTH_ISSUER` は Vercel の本番 URL にする。
- サーバーレスなので、**メモリに数えるレート制限はほとんど効かない**(リクエストごとに別のプロセスになりうる)。そのため、本番では DB の `rate_limit` テーブルに数える: Better Auth の制限(上の手順)と、マジックリンクの宛先ごとの制限(`src/lib/database-rate-limit.ts`。Better Auth と同じテーブルと同じ規則で、キーは `action:<名前>:<ID>` で衝突しない)。記録されるのは、キー(IP や小文字にそろえたメールアドレス)、回数、最後の時刻だけ。1 時間より古い行は、新しい時間枠の開始時に消える。開発とテストはメモリ版(`NODE_ENV=production` のときだけ DB 版)。DB 版は 1 つの SQL で数えるので、同時に来たリクエストでも上限を超えない(実 Postgres のテストで 40 件同時に投げて、通るのが 5 件であることを確認)。**DB に届かないときは、リクエストを通す**(制限は歯止めで、数えられない障害で全員を締め出さないため。ログには残す)。
- Neon は **pooled URL**(ホスト名に `-pooler`)を使う。インスタンスの数だけプールが増えるので、`DATABASE_POOL_MAX` は小さく設定する(3 前後を想定)。マイグレーションは `DATABASE_URL_UNPOOLED`。
- Vercel は `x-forwarded-for` にクライアントの IP を入れる(上書きして偽装を防ぐ、と理解している。**要確認**)。デプロイ後に実際の値を見て、`advanced.ipAddress` が既定のままで足りるか決める。HSTS も Vercel が付けるか確認する(要確認)。

## 公開前チェックリスト
- レート制限(連打対策)は、**サインイン用のメールだけ**にかけている(ログインしていない誰でも押せて、押すたびにメールが送られる唯一の場所のため)。(1) IP ごと: Better Auth のマジックリンクのプラグイン標準(1 分に 5 回)。本番だけ有効(開発は無効)。(2) 宛先ごと: 10 分に 3 通(`src/lib/rate-limits.ts` の `allowMagicLinkTo`)。制限されても画面は「メールを確認してください」のままで、どのアドレスが狙われているかは分からない(画面には、届かないときの一般的な案内「迷惑メールを確認し、10 分待ってからやり直す」を出す)。キーはメールアドレスのハッシュ(アドレス自体は DB に残らない。Better Auth 側の行には IP が残り、1 時間より古い行は消える)。**既知の限界(トレードオフとして受け入れている):** (a) 他人が狙ったアドレスに 10 分に 3 回要求し続けると、そのアドレスの本人には、メールが届かない(メール爆弾を防ぐ代わりに、妨害に使われうる)。IP ごとの制限(1 分に 5 回)は、複数の IP から出されると効かない。(b) `a+1@gmail.com` と `a+2@gmail.com` は別のアドレスとして数えるので、同じ受信箱への連続送信は、この制限では止まらない(IP ごとの制限が補う)。他の操作(Google ログイン・紐づけ・解除、プロフィール保存、退会)は、ログイン済みか Google が見張っているか、すでに強く守られているため、独自の制限はかけない(Better Auth の既定の制限だけが本番で効く)。必要になったら、`database-rate-limit.ts` を使って足せる。本番では、どちらも DB に数える(上の「デプロイ先」)。**デプロイ先が決まったら、必ず確認する(評価者の指摘):** Better Auth はクライアントの IP を `x-forwarded-for` から取る。`trustedProxies` がないと、この値が **1 つのときだけ**採用し、`client, proxy` のように複数あると IP が取れず、全員が同じ 1 つの枠を共有する(少数のリクエストでログインが止まる)。逆に、プロキシが `x-forwarded-for` を上書きしない構成では、偽装で制限を回避できる。デプロイ先に合わせて `auth.ts` の `advanced.ipAddress`(`ipAddressHeaders` か `trustedProxies`)を設定する。**未設定のままなので、単一のプロキシ(`x-forwarded-for` が 1 つ)を前提にしている**
- `trustedOrigins` を設定する(Tauri / Expo など、別のオリジンのクライアントを足すとき)
- マジックリンクのサインアップを制限するか決める(`disableSignUp`)。今は、メールアドレスを知っていれば誰でも新規登録できる(Google では新規登録できない)
- 本番の Google Cloud Console に、本番の URL のリダイレクト URI(`https://<本番のドメイン>/api/auth/callback/google`)を登録する
- メール HTML の URL をエスケープする
- **CSP は入っているが、まだ「報告だけ」のモード(止めない)。** 本番(Vercel のプレビュー)で、ブラウザのコンソールに `[Report Only]` の違反が出ないことを確かめてから、`src/lib/csp.ts` の `CSP_MODE` を `"enforce"` に変える(1 行)。E2E は開発サーバーで動かすので、本番だけの差(`'unsafe-eval'` なし、`upgrade-insecure-requests` あり)と、開発用の画面部品(`next-devtools`)の除外は、E2E では確かめられない。Google ログインなど、外部のサイトへ移る操作は、ナビゲーションなので CSP の対象外だが、強制の前に手で一度通す。**強制の前に、手で確かめること:** (1) 全画面(ログイン、メール確認、プロフィール、編集、退会、Google の紐づけ・解除)をプレビューで通し、コンソールに違反が出ない。(2) 存在しない URL を開く(`/_not-found` はビルドで静的になっており、nonce のないスクリプトになる恐れがある。違反が出たら、404 を動的にする: `not-found` で `await connection()`)。(3) Vercel のプレビューには Vercel Toolbar などのウィジェット(`vercel.live`)が入り、違反に見えることがある。本番にも出る違反かを見分ける。(4) 違反の報告先(`report-to`)はない。コンソールを見落とさない。**今後、静的なページ(セッションを読まないページ)を足すと、nonce が付かず、強制では動かなくなる**
- HSTS: コードでは付けていない。Vercel が自動で付けるはずなので、デプロイ後に `curl -sI https://<本番のドメイン> | grep -i strict-transport` で確認する(付いていなければ、`next.config.ts` の `headers()` に足す)
- CI の GitHub Actions がタグ指定(`@v7`)で、コミット SHA 固定ではない
- Server Action の `allowedOrigins`:リバースプロキシの背後で、Server Action が Origin の不一致で断られないか確認する
- Better Auth に `cookieCache` を入れるなら、`updateProfile` の `currentName: session.user.name`(セッションの名前との比較)をやめ、bio と同じく `initialName` の hidden 値と比べる(セッションが古い名前を返すと、A→B→A と戻した保存が「変更なし」と判定されて DB に書かれない)

## 進捗ファイル
- `claude-progress.txt` に、完了・実行中・これからのタスクを書く。新しいセッションは、最初にこのファイルと CLAUDE.md を読む
- goal が終わるたびに(ループの終了時の報告と一緒に)更新する。長いセッションで文脈が劣化しても、続きから始められるようにするため
- PR を作るとき(頼まれたとき)は、PR の前に `claude-progress.txt` を書き直す: 完了したものを「完了したタスク」に移し、「実行中」を現状に合わせ(「コミット直前」などの古い記述を消す)、「これから」の先頭を次の作業にする。進捗ファイルの変更も同じ PR に入れる
