# 設計メモ(機能ごとの詳細)

CLAUDE.md から切り出した、実装の方針と理由。コードを変えたら、ここも合わせて直す。

## DB 接続(`src/lib/db.ts`、`src/lib/database-config.ts`)
- 本番(`NODE_ENV=production`)では、`DATABASE_URL` に `sslmode=require`(または `verify-ca` / `verify-full`)がないと起動時にエラー(Go と同じ)。`next build` の間は検査しない(ダミーの設定で接続しないため)。開発は強制しない
- プールは `globalThis` に 1 つだけ(ホットリロードで増えない)。最大 10 接続(`DATABASE_POOL_MAX` で 1〜50)、接続待ち 5 秒、クエリ 10 秒(クライアント側の `query_timeout`)。サーバー側の `statement_timeout` を起動パラメータで送ると、Neon の pooled URL などが拒否する恐れがあるので使わない。アイドル接続のエラーはログに出す
- `DATABASE_URL_UNPOOLED` は `drizzle-kit` 専用(`-pooler` の付かない直接つなぐ URL。プール経由だとマイグレーションが固まる)

## CSP(`src/proxy.ts`、`src/lib/csp.ts`)
- ページへのリクエストごとに nonce を作り、nonce の付いた自分たちのスクリプトだけ実行を許すポリシーをヘッダーで返す(Next.js はリクエストのヘッダーから nonce を拾って自分のスクリプトに付ける)
- `unsafe-inline` は使わない。`unsafe-eval` は開発だけ。`frame-ancestors 'none'`、`object-src 'none'` なども付く
- 今は `Content-Security-Policy`(強制)。問題が出たら `CSP_MODE` を `"report-only"` に戻せば止められる(1 行)
- ページを毎回描画する必要がある(全ページがセッションを読むので満たしている)。API のルート、静的ファイル、先読みには付けない
- **静的なページ(セッションを読まないページ)を足すと nonce が付かず、強制では動かなくなる。** 404 は標準だとビルド時に静的になるので、`src/app/not-found.tsx` で `await connection()` を呼んで動的にしてある。E2E は開発サーバーで動くのでこの退行は捕まえられない。静的なページを足したら、本番ビルドを手元で起動して、HTML のスクリプトとスタイルすべてにヘッダーと同じ nonce が付くことを確かめる
- E2E は、ヘッダーの nonce がページのスクリプトに付いていることと、違反の報告が出ないことを確かめる。`report-to` はないので、本番で問題が出たらブラウザのコンソールを見る

## Go API の呼び出し
- `src/lib/api.ts` の `apiRequest`(トークンを受け取る低レベル関数。204 は本文なしの成功)と、`src/lib/api-server.ts` の `callApi` / `getMyProfile`(サーバー用。JWT を自分で発行する)
- JWT は `Authorization: Bearer`。ベース URL は `API_BASE_URL`(開発は未設定なら `http://localhost:8080`、本番では必須で https)。5 秒でタイムアウト

## プロフィール
- `/profile`(Server Component、閲覧のみ): email と name はセッション、bio は Go の `GET /me/profile`。Edit ボタンで `/profile/edit` へ。API が落ちていても email と name は表示し、bio の欄にだけエラーを出す
- `/profile/edit`(Server Component): name と bio のフォーム(`src/components/profile-form.tsx`)と Cancel リンク。API が落ちていても name は保存できる(bio 欄は出さないので、空で上書きされない)。保存後は、失敗したフィールドがなければ `/profile` へ、一部でも失敗したら `/profile/edit` に残してフィールドごとに結果を出す(判定は `shouldLeaveEditPage`)
- 保存: Server Action `updateProfile`(`src/app/profile/actions.ts`)。セッションを確認し、変更したフィールドだけ書く。name は Better Auth の `updateUser`(Web の DB)、bio は `callApi` で Go の `PUT /me/profile`。2 つの DB にまたがるのでトランザクションはなく、独立に書いて結果をフィールドごとに出す(どちらも冪等なので再送で直る)。検証と書き込みのロジックは `src/lib/profile-form.ts`

## ログインと Google
- ユーザーはマジックリンクで作られる(これが root。ユーザー ID = JWT の `sub` がここで決まる)。Google は、ログイン済みのユーザーが後から足す**任意のログイン手段**で、ユーザーを新しく作れない
- Google は `GOOGLE_CLIENT_ID` と `GOOGLE_CLIENT_SECRET` を**両方**設定すると有効(未設定なら無効、片方だけだと起動時にエラー。判定は `src/lib/google-oauth.ts` の `resolveGoogleCredentials`)。承認済みリダイレクト URI は `<BETTER_AUTH_URL>/api/auth/callback/google`
- 方針は `src/lib/google-auth-options.ts` の `googleAuthOptions`(`auth.ts` が使う):
  - `google.disableSignUp: true`(Google では新規登録できない)
  - `accountLinking.disableImplicitLinking: true`(同じメールでも自動では紐づけない)
  - `allowDifferentEmails: true`(Google のメールが root と違ってもよい。紐づけにはログイン中のセッションが要る。セッションなしで紐づけられる経路があるとアカウント乗っ取りになりうる)
  - `allowUnlinkingAll: true`(マジックリンクは常に使えるので、最後の 1 行も解除できる)
- テスト `src/lib/google-auth.test.ts`: 本物の Better Auth をメモリ上の DB で動かし、Google のトークン交換(`fetch`)だけ偽物にする。新規登録できない、未紐づけは入れない、紐づけると同じユーザーで入れる、解除すると入れない、他人に紐づいた Google は紐づけられない、セッションなしでは紐づけを始められない、を守る。画面と本物の Google との往復は対象外
- **セッション盗難の対策**(盗んだ人が自分の Google を紐づけると、盗んだセッションが切れた後も入れてしまう):
  1. 紐づけ(`/link-social`)にも、解除と同じ「新しいログイン」を要求する。`hooks.before` で、ログインから `FRESH_SESSION_SECONDS`(5 分。Better Auth の既定は 1 日)を過ぎていたら `SESSION_NOT_FRESH`(403)で断る。この値は新しさを求める他の操作にも効く
  2. 紐づけの行ができたら(`databaseHooks.account.create.after`)、Google のメールではなく **root のメール**に知らせる(`src/lib/linked-accounts.ts` の `linkedAccountEmail`、送信は `auth.ts` の `notifyLinked`。失敗しても紐づけは成功する)
  - 画面は、断られたときに「ホームでサインアウト → メールリンクで入り直す → もう一度」と案内する
  - 残る弱点: 5 分以内に盗まれたセッションは紐づけられる。最後の手段はメール通知。さらに強くするなら、紐づけの前に root のメールへ確認リンクを送る方式がある(未実装)
- 紐づけ: `/profile` の「Other ways to sign in」で「Link Google」(`authClient.linkSocial`、`src/components/link-google-button.tsx`)。紐づけ済みなら「Google: linked」。有効なときだけ表示(`googleEnabled`)
- 解除: 「Google: linked」の横の「Unlink Google」(`authClient.unlinkAccount`、`src/components/unlink-google-button.tsx`)。最近のログイン(5 分以内)が要る(`SESSION_NOT_FRESH` ならログインし直すよう案内。文言は `src/lib/linked-accounts.ts`)
- ログイン: `/login` の「Continue with Google」は、紐づけ済みの Google だけが入れる。未紐づけだと `/login?error=...` に戻り、`src/lib/oauth-errors.ts` の `oauthErrorMessage` が既知のコード(`signup_disabled`、`account_not_linked` など)だけ文言に変える(未知のコードは汎用の文言で、クエリをそのまま出さない)
- 紐づけたユーザーでも `sub` は root のままなので、Go の `profiles` はそのまま使える。Go は変えない
- 画面からは 1 ユーザーに Google は 1 つだけ(紐づけ済みなら「Link Google」を隠す)。1 つの Google を複数ユーザーに紐づけることは Better Auth が止める
- 未対応: 他のプロバイダ

## 退会(`/profile` の「Delete account」、`src/components/delete-account-form.tsx`)
- Server Action `deleteMyAccount`(`src/app/profile/actions.ts`)が `src/lib/delete-account.ts` の `deleteAccount` を呼ぶ。順序: (1) `revokeOtherSessions`(新しい JWT が出なくなる)→ (2) Go の `DELETE /me`(冪等、204)→ (3) Better Auth の `deleteUser`(user を消すと session と account は外部キー cascade と Better Auth で消える)。途中で失敗したらそこで止まり、ユーザーは残る。再送で全部やり直せる
- 入力した確認用メールが一致しないと何も呼ばない
- `deleteUser` は新しいログイン(5 分)を要求するが、Go のデータを消した後に断られると「データのないアカウント」が残るので、`deleteAccount` が最初に鮮度を確かめる
- 成功したら root のメールに通知(`notifyDeleted`。宛先は `deleteAccount` がセッションのメールに決める。入力した確認用メールではない。`after()` で非同期、失敗しても退会は成功)。盗まれたセッションでの退会に本人が気づくため
- `user.deleteUser.enabled` は `google-auth-options.ts` にあり、`google-auth.test.ts` の「account deletion」が守る。Cookie を消すため `auth.ts` の plugins の最後に `nextCookies()` を入れてある
- **HTTP 経由では拒否するエンドポイント:** `/api/auth/delete-user`、`/update-user`、`/token`(と `/get-access-token`、`/refresh-token`)。確認用メール・Go のデータ削除・通知・名前の検証は Server Action にしかないので、Cookie だけで素通りされる(再現済み)。`/token` は、Cookie だけで JWT を取れると、盗まれたセッションや画面上のスクリプトが、5 分の新しいログイン確認を通らずに Go の `DELETE /me` などを直接呼べるため。`google-auth-options.ts` の `hooks.before` が、受信リクエストのある呼び出し(HTTP)だけ 403 `SERVER_ONLY` で断る。Server Action の `auth.api.*` はリクエストがないので通る。`callApi` は `auth.api.getToken` を使うので影響しない。公開鍵の `/api/auth/jwks` は Go が取りに来るので公開のまま
- デスクトップやモバイルが Go を直接呼ぶ構成にするときは、このルールを見直す(専用エンドポイントにする、など)。`sendDeleteAccountVerification` や `changeEmail` を有効にするときも、ガードとテスト(`/delete-user/callback` など)を見直す
- 退会後に残るもの(`deleteUser` が消すのは user、session、account だけ):
  - `jwks`: 全ユーザー共通の署名鍵で個人のデータではない。消してはいけない
  - `verification`: 未使用のマジックリンクの行が残りうる(`value` に email)。有効期限は既定 5 分なので、最大 5 分分で期限が切れたら無効
- 期限切れの行の掃除: Vercel Cron が毎日 1 回(`vercel.json`、18:00 UTC = 03:00 JST)`GET /api/cron/cleanup` を呼ぶ(`src/lib/cleanup.ts`)。消すのは、期限切れの `verification` と `session`、1 日以上触られていない `rate_limit`。`jwks` と user は消さない。`CRON_SECRET`(Vercel が Bearer で自動で送る)と一致しないと何もしない。未設定なら 503。Cron は本番のデプロイだけで動く

## メール送信
`EMAIL_TRANSPORT` で `resend` か `console`(ログ出力)を選ぶ(`src/lib/email.ts`)。本番では `resend` だけ(未設定・`console`・`file` は送信時にエラー。リンクがログやディスクに残らないように)。開発は未設定なら `console`。E2E だけ `file`(`e2e/.tmp/mail.jsonl`)

## レート制限
- サインイン用のメールだけにかけている(ログインしていない誰でも押せて、押すたびにメールが送られる唯一の場所)
  1. IP ごと: Better Auth のマジックリンクのプラグイン標準(1 分に 5 回)。本番だけ有効
  2. 宛先ごと: 10 分に 3 通(`src/lib/rate-limits.ts` の `allowMagicLinkTo`)。制限されても画面は「メールを確認してください」のまま(どのアドレスが狙われているか分からない)。キーはメールアドレスのハッシュ
- 他の操作(Google、プロフィール保存、退会)は、ログイン済みか Google が見張っているか既に強く守られているので、独自の制限はかけない。必要なら `database-rate-limit.ts` で足せる
- サーバーレスではメモリに数えても効かないので、本番は DB の `rate_limit` テーブルに数える(Better Auth は `storage: "database"`、宛先ごとは `src/lib/database-rate-limit.ts`。同じテーブル・同じ規則で、キーは `action:<名前>:<ID>`)。1 つの SQL で数えるので同時リクエストでも上限を超えない。**DB に届かないときは通す**(制限は歯止めで、障害で全員を締め出さないため。ログには残す)。開発とテストはメモリ版
- 既知の限界(受け入れている): (a) 他人が狙ったアドレスに 10 分に 3 回要求し続けると、本人にメールが届かない(妨害に使われうる)。IP ごとの制限は複数 IP からでは効かない。(b) `a+1@gmail.com` と `a+2@gmail.com` は別のアドレスとして数える(IP ごとの制限が補う)
