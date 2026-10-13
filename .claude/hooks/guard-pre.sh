#!/usr/bin/env bash
# PreToolUse: 禁止事項を実行前にブロックする(exit 2 + stderr で Claude に理由を返す)
set -u
input=$(cat)
tool=$(jq -r '.tool_name // ""' <<<"$input")
cmd=$(jq -r '.tool_input.command // ""' <<<"$input")
path=$(jq -r '.tool_input.file_path // .tool_input.path // ""' <<<"$input")
# 書き込まれる内容(Write: content / Edit: new_string / MultiEdit: edits[].new_string)
content=$(jq -r '[.tool_input.content, .tool_input.new_string, (.tool_input.edits[]?.new_string)] | map(select(. != null)) | join("\n")' <<<"$input")

block() { echo "BLOCKED by guard-pre.sh: $1" >&2; exit 2; }

rel=${path#"${CLAUDE_PROJECT_DIR:-$PWD}"/}

# --- .env の読み取り(.env.example は許可) ---
is_env_path() { [[ "$(basename "$1")" == .env* && "$(basename "$1")" != ".env.example" ]]; }
if [[ -n "$path" ]] && is_env_path "$path"; then
  block ".env 系ファイルは読まない(.env.example は可)"
fi
if [[ "$tool" == "Bash" ]]; then
  stripped=${cmd//.env.example/}
  if grep -Eq "(^|[[:space:]/\"'=])\.env(\.[A-Za-z0-9._-]+)?(\$|[[:space:]\"'|;&)])" <<<"$stripped"; then
    block ".env 系ファイルをコマンドで読まない(.env.example は可)"
  fi
fi

# --- rm の再帰削除: 再生成できるものだけ許す ---
sep='(^|[;&|][[:space:]]*)'
# 再帰削除してよい名前(消しても、install やビルドで作り直せるもの)
RM_ALLOWED='node_modules|\.next|\.next-e2e|\.expo|dist|coverage|test-results|playwright-report|tmp|bin|\.turbo'

# rm の再帰削除で、許可リストにない対象を含むなら 0(= 危険)を返す。再帰でない rm や、対象が全部許可なら 1。
rm_recursive_unsafe() {
  local cmd="$1" seg tok recursive
  set -f # 展開させない(* や ? をそのまま文字列として見る)
  while IFS= read -r seg; do
    recursive=0
    for tok in $seg; do
      [[ "$tok" =~ ^-[a-zA-Z]*[rR][a-zA-Z]*$ || "$tok" == "--recursive" ]] && recursive=1
    done
    [[ $recursive -eq 0 ]] && continue
    for tok in $seg; do
      [[ "$tok" == -* ]] && continue
      # 相対パスで、先頭は web/ api/ mobile/ のどれかだけ(web/node_modules など。src/bin のようなものは通さない)。.. ・絶対パス・~・変数・ワイルドカード・引用符も通さない
      [[ "$tok" =~ ^(\./)?((web|api|mobile)/)?(${RM_ALLOWED})/?$ ]] || { set +f; return 0; }
    done
  done < <(grep -Eo "${sep}rm[[:space:]]+[^;&|]*" <<<"$cmd" | sed -E 's/^[;&|[:space:]]*rm[[:space:]]+//')
  set +f
  return 1
}

# --- Bash の危険操作 ---
if [[ "$tool" == "Bash" ]]; then
  sep='(^|[;&|][[:space:]]*)'
  grep -Eq "${sep}git[[:space:]]+(-[^[:space:]]+[[:space:]]+)*(push|clean|reset[[:space:]]+--hard)" <<<"$cmd" \
    && block "git push/clean/reset --hard は人が頼むまでしない(commit はローカルで取り消せるので許可。外に出る push は人が実行する)"
  rm_recursive_unsafe "$cmd" \
    && block "rm の再帰削除(-r)は、再生成できるもの(node_modules、.next、dist など)だけ許可。それ以外は人に確認する"
  grep -Eq "npm[[:space:]]+run[[:space:]]+db:(migrate|schema)|drizzle-kit[[:space:]]+(migrate|push)|auth@latest[[:space:]]+generate" <<<"$cmd" \
    && block "マイグレーション/スキーマ再生成(db:migrate, db:schema, drizzle-kit migrate|push)は人が頼んだときだけ。手順を案内するに留める"
fi

# --- 保護対象ファイルの編集禁止 ---
if [[ "$tool" =~ ^(Edit|Write|MultiEdit)$ && -n "$rel" ]]; then
  case "$rel" in
    drizzle/*|drizzle.config.ts) block "drizzle/ は生成物。db:generate を人が実行する" ;;
    src/db/schema.ts) block "src/db/schema.ts は生成物で手編集禁止(db:schema を人が実行する)" ;;
    package-lock.json) block "package-lock.json は手編集しない(npm コマンド経由で更新する)" ;;
  esac

  # --- 型・lint・テストを黙らせる回避の禁止 ---
  case "$rel" in
    *.ts|*.tsx|*.mts|*.mjs)
      grep -Eq '@ts-ignore|@ts-expect-error|eslint-disable|as unknown as|as any\b|:[[:space:]]*any[[:space:]]*[;,=)>|\]]' <<<"$content" \
        && block "@ts-ignore / @ts-expect-error / eslint-disable / as unknown as / any は使わない。型を正しく直す"
      ;;
  esac
  case "$rel" in
    *.test.ts|*.test.tsx|eslint.config.mjs|vitest.config.mts|tsconfig.json)
      grep -Eq '\b(it|test|describe)\.(skip|only|todo)\b|"strict"[[:space:]]*:[[:space:]]*false|:[[:space:]]*"off"|exclude' <<<"$content" \
        && block "テスト/設定を弱める変更(skip/only/todo, strict:false, rule off, exclude)は禁止。やむを得ないなら理由を報告して人の確認を待つ"
      ;;
  esac
fi
exit 0
