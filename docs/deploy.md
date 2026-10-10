# デプロイと公開前チェック

## デプロイ先
- Web: **Vercel + Neon**(サーバーレス)。API(Go)とその DB は **Render**。Go は Vercel の https の JWKS(`<本番の URL>/api/auth/jwks`)を取りに来るので、Go の `AUTH_ISSUER` は Vercel の本番 URL にする
- Neon は **pooled URL**(ホスト名に `-pooler`)。インスタンスの数だけプールが増えるので `DATABASE_POOL_MAX` は小さく(3 前後)。マイグレーションは `DATABASE_URL_UNPOOLED`
- Vercel の Production に `CRON_SECRET`(`openssl rand -base64 32` で作った値、Secret)が要る(掃除の Cron 用。`docs/design.md`)
- サーバーレスなので、メモリに数えるレート制限はほとんど効かない。本番は DB に数える(`docs/design.md` の「レート制限」)

## レート制限の保存先を DB にする手順(人が実行する)
`auth.ts` は Better Auth のレート制限を `storage: "database"` にしている。Better Auth は起動時に Drizzle のスキーマを検査し、`rateLimit` テーブルがないと **`Missing tables: rateLimit` でエラー**になる。次の順で人が実行する(hook は私が実行するのを止める):
1. `npm run db:schema`(`src/db/schema.ts` を再生成)
2. `npm run db:generate`(`drizzle/` にマイグレーションの SQL を作る)
3. `npm run db:migrate`(`.env.local` の `DATABASE_URL_UNPOOLED` が指す DB に適用。**本番の Neon にも、デプロイの前に同じ SQL を適用する**。プレビューが別の Neon ブランチを指すなら、そちらにも)

`rate_limit` がない DB では、Better Auth のレート制限対象の認証リクエストが失敗する。一方、宛先ごとの制限は数えられなければ通す(fail-open)ので、壊れても気づきにくい。古いコードに戻すとき、テーブルが残っていても害はない。E2E と実 Postgres のテストは `drizzle/` の SQL を直接流すので、2 のあとは追加作業が要らない。

## 公開前チェックリスト
- **クライアントの IP(要確認):** Better Auth は IP を `x-forwarded-for` から取る。`trustedProxies` がないと、値が **1 つのときだけ**採用し、`client, proxy` のように複数あると IP が取れず、全員が同じ枠を共有する(少数のリクエストでログインが止まる)。逆に、プロキシが `x-forwarded-for` を上書きしない構成では、偽装で制限を回避できる。デプロイ後に実際の値を見て、`auth.ts` の `advanced.ipAddress`(`ipAddressHeaders` か `trustedProxies`)を設定する。**今は未設定で、単一のプロキシ(`x-forwarded-for` が 1 つ)を前提にしている**
- `trustedOrigins` を設定する(Tauri / Expo など別オリジンのクライアントを足すとき)
- マジックリンクのサインアップを制限するか決める(`disableSignUp`)。今はメールアドレスを知っていれば誰でも新規登録できる(Google では新規登録できない)
- 本番の Google Cloud Console に、本番の URL のリダイレクト URI(`https://<本番のドメイン>/api/auth/callback/google`)を登録する
- メール HTML の URL をエスケープする
- HSTS: コードでは付けていない。Vercel が自動で付けるはずなので、`curl -sI https://<本番のドメイン> | grep -i strict-transport` で確認する(付いていなければ `next.config.ts` の `headers()` に足す)
- CI の GitHub Actions がタグ指定(`@v7`)で、コミット SHA 固定ではない
- Server Action の `allowedOrigins`: リバースプロキシの背後で、Origin の不一致で断られないか確認する
- Better Auth に `cookieCache` を入れるなら、`updateProfile` の `currentName: session.user.name` の比較をやめ、bio と同じく `initialName` の hidden 値と比べる(セッションが古い名前を返すと、A→B→A と戻した保存が「変更なし」と判定されて書かれない)
