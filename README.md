# better-auth-multi-platform (web)

ひとつのログインを、複数のクライアントで共有するためのサンプルです。Web アプリが
[Better Auth](https://www.better-auth.com) でログインを担当し、別サービスの Go API が、その
トークンを信頼して使います。将来は、デスクトップ(Tauri)とモバイル(Expo)からも、Go を変えずに
同じ API を使えるようにする予定です(今は Web のみ)。

このリポジトリは Web 側(Next.js)です。Go API は
[better-auth-multi-platform-api](https://github.com/shu915/better-auth-multi-platform-api) にあります。

## 全体像

```
ブラウザ ──▶ Next.js (Vercel) ──▶ Go API (Render)
               │  Better Auth        │  公開鍵で JWT の署名を検証
               ▼                     ▼
           Postgres (Neon)      Postgres (Render)
         ユーザー、セッション、    プロフィール(bio)
         署名鍵
```

- **ログインはマジックリンク。** パスワードは使いません。最初のマジックリンクでユーザーが作られ、
  そのユーザー ID が、すべてのトークンの `sub` になります。
- **Google は任意で、ユーザーは作れません。** ログイン済みのユーザーが、`/profile` から Google を
  紐づけ・解除できます。紐づけには、直近 5 分以内のログインが必要で、紐づけたら、元のメール
  アドレスに通知が届きます。
- **ブラウザは JWT を持ちません。** Next.js のサーバーが、Go API を呼ぶたびに、短命(5 分)の
  トークンを発行して付けます(`src/lib/api-server.ts`)。Go は、`/api/auth/jwks` の公開鍵で署名を、
  あわせて issuer と audience を検証します。
- **退会**(`/profile`): 他のセッションを失効し、Go 側のデータを消し、ユーザーを削除して、元の
  メールアドレスに通知します。確認用のメールアドレスの入力と、直近のログインを求めます。
- **サーバーだけが呼べるエンドポイント**(`/api/auth/delete-user`、`/update-user`、`/token`、
  Google のトークン系)は、HTTP 経由では `403` を返します。Cookie だけで、Server Action にある
  ルール(確認入力、Go のデータ削除、通知など)を飛ばせないようにするためです。

## 技術スタック

Next.js 16 (App Router) · React 19 · TypeScript · Tailwind CSS v4 · Better Auth · Drizzle ·
Postgres (Neon) · Resend · Vitest · Playwright

## 手元で動かす

必要なもの: Node.js、この Web 用の Postgres(無料の [Neon](https://neon.tech) で足ります)、
動いている Go API(API のリポジトリを参照)。

```bash
npm ci
cp .env.example .env.local     # 中身を埋める(下の表を参照)
npm run db:migrate             # テーブルを作る
npm run dev                    # http://localhost:3000
```

開発中は、メールを端末に出力します(`EMAIL_TRANSPORT=console`)。ログインのリンクは、
`npm run dev` の出力に出ます。

### 環境変数

| 変数 | 説明 |
|---|---|
| `BETTER_AUTH_SECRET` | 必須。長いランダムな文字列(例: `openssl rand -base64 32`)。 |
| `BETTER_AUTH_URL` | このアプリの公開 URL(末尾に `/` を付けない)。Go の `AUTH_ISSUER` と同じにする。本番では必須。 |
| `JWT_AUDIENCE` | Go の `AUTH_AUDIENCE` と同じにする。既定は `better-auth-multi-platform-api`。 |
| `API_BASE_URL` | Go API のベース URL。開発では未設定なら `http://localhost:8080`。本番では必須で、`https` のみ。 |
| `DATABASE_URL` | 実行時に使う Postgres の接続文字列。Neon なら pooled のもの。本番では `sslmode=require` 以上が必要。 |
| `DATABASE_URL_UNPOOLED` | `drizzle-kit`(マイグレーション)だけが使う。Neon なら `-pooler` の付かない、直接つなぐもの。 |
| `DATABASE_POOL_MAX` | 任意。1 インスタンスの接続数(1〜50、既定 10)。サーバーレスでは小さい値が向く。 |
| `EMAIL_TRANSPORT` | `console`(開発)か `resend`。本番では `resend` のみ。 |
| `RESEND_API_KEY`、`EMAIL_FROM` | `EMAIL_TRANSPORT=resend` のときに必要。送信元のドメインを Resend で認証しておく。 |
| `GOOGLE_CLIENT_ID`、`GOOGLE_CLIENT_SECRET` | 任意。両方設定すると Google の紐づけが有効になる。リダイレクト URI は `<BETTER_AUTH_URL>/api/auth/callback/google`。 |
| `CRON_SECRET` | 本番。毎日の掃除のエンドポイントを守る(下の「デプロイ」を参照)。 |

## コマンド

| コマンド | 内容 |
|---|---|
| `npm run dev` / `build` / `lint` | 開発サーバー、ビルド、lint。 |
| `npm test` | 単体・結合テスト(Vitest)。Postgres が要るテストは、`TEST_DATABASE_URL` を設定すると動く。専用のスキーマを作って消すので、本物のデータがない DB を指すこと。 |
| `npm run test:e2e` | 本物のブラウザ、この Web、Go API、Postgres を通す E2E を 1 本(ログイン、プロフィール編集、退会)。API のリポジトリが隣(`../api`。`API_DIR` で変更可)にあることと、Postgres 用の Docker が要る。 |
| `npm run db:generate` / `db:migrate` | Drizzle のマイグレーションの生成と適用。 |

## デプロイ

本番の構成は、Web を Vercel と Neon、Go API とその DB を Render に置いています。DB への往復を
短くするため、すべて同じリージョン(シンガポール)にそろえています。

1. 本番の Neon に、`npm run db:migrate` でマイグレーションを適用する(unpooled の URL を使う)。
2. Go API を先に、次にこのアプリをデプロイする(Web の退会が Go を呼ぶため)。
3. 上の環境変数を Production に設定する。パスワードを含む値は Secret にする。
4. Vercel Cron(`vercel.json`)が、毎日 `/api/cron/cleanup` を呼び、期限切れのログインリンク、
   期限切れのセッション、古いレート制限の行を消す。`CRON_SECRET` が付かないリクエストでは、
   何もしない。

本番で強制しているもの: API の URL は https のみ、DB は TLS、メールは `console` を拒否、リクエスト
ごとの nonce つき Content-Security-Policy(`src/proxy.ts`)、ログイン用メールのレート制限
(IP ごとと宛先ごと。DB で数える)。

## テスト

- **Vitest**: ロジック、Better Auth の設定、Server Action の結線、実 Postgres での外部キーや
  マイグレーション、HTTP 越しの `apiRequest`、Cron の削除。
- **Playwright(E2E)**: ログイン、編集、退会を、本物の Go API と Postgres で通す。
- 守りたい設定を壊すと、テストが落ちることを、そのつど確かめています。
- CI(GitHub Actions)は、`check`(型、lint、テスト、ビルド)と `e2e` の 2 ジョブ。DB を使う
  テストが SKIP されると、失敗にします。
- 画面(コンポーネント)のテストは、入れていません。

## 既知の限界

- Go API に、独自のレート制限はありません。
- 退会のあとも、トークンは最大 5 分有効で、その間のリクエストが、プロフィールの行を作り直す
  ことがあります。
- 宛先ごとのメールの制限は、特定の人のログインを、しばらく妨げるのに使えます。
- セッションを読まない静的なページは、ビルド時に 1 回だけ作られ、nonce が付かないため、強制中の
  CSP に止められます。そのようなページは、リクエストごとに描画してください
  (`src/app/not-found.tsx` を参照)。

設計の判断など、開発者向けの詳しい記述は、`CLAUDE.md` と `claude-progress.txt` にあります。
