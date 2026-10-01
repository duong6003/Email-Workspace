#!/bin/sh
set -eu

migrations_dir='/database/migrations'

: "${EOW_POSTGRES_APP_PASSWORD:?EOW_POSTGRES_APP_PASSWORD is required}"

migration_checksum() {
  if command -v sha256sum >/dev/null 2>&1; then
    checksum_output="$(sha256sum "$1")" || {
      printf 'Migration checksum command failed: sha256sum.\n' >&2
      return 1
    }
    checksum="$(printf '%s\n' "$checksum_output" | awk '{print $1}')"
  elif command -v shasum >/dev/null 2>&1; then
    checksum_output="$(shasum -a 256 "$1")" || {
      printf 'Migration checksum command failed: shasum.\n' >&2
      return 1
    }
    checksum="$(printf '%s\n' "$checksum_output" | awk '{print $1}')"
  elif command -v openssl >/dev/null 2>&1; then
    checksum_output="$(openssl dgst -sha256 "$1")" || {
      printf 'Migration checksum command failed: openssl.\n' >&2
      return 1
    }
    checksum="$(printf '%s\n' "$checksum_output" | awk '{print $NF}')"
  else
    printf 'Migration checksum tool unavailable: need sha256sum, shasum, or openssl.\n' >&2
    return 1
  fi

  [ -n "$checksum" ] || {
    printf 'Migration checksum output could not be parsed.\n' >&2
    return 1
  }
  case "$checksum" in
    *[!0123456789abcdef]*|'')
      printf 'Migration checksum output is not a lowercase SHA-256 digest.\n' >&2
      return 1
      ;;
  esac
  if [ "${#checksum}" -ne 64 ]; then
    printf 'Migration checksum output is not a lowercase SHA-256 digest.\n' >&2
    return 1
  fi
  printf '%s\n' "$checksum"
}

# This trusted-corpus guard runs before BEGIN and before \i. It rejects source that
# could use psql meta-commands or transaction control to escape runner transaction.
# It masks SQL comments, quoted text, nested block comments, and dollar-quoted bodies.
migration_source_is_safe() {
  LC_ALL=C awk '
    function reject() { unsafe = 1 }
    function check_statement(  normalized) {
      normalized = statement
      sub(/^[[:space:]]+/, "", normalized)
      normalized = tolower(normalized)
      if (normalized ~ /^(abort|begin|commit|end|rollback|savepoint|release)([[:space:]]|$)/ ||
          normalized ~ /^start[[:space:]]+transaction([[:space:]]|$)/ ||
          normalized ~ /^prepare[[:space:]]+transaction([[:space:]]|$)/) reject()
      if (normalized ~ /^copy[[:space:]]+[^()]+([[:space:]]*\([^;]*\))?[[:space:]]+from[[:space:]]+stdin([[:space:]]|\(|$)/) copy_data = 1
      statement = ""
    }
    function is_identifier_start(character) {
      return character ~ /[A-Za-z_]/ || character ~ /[\200-\377]/
    }
    function is_identifier_continuation(character) {
      return character ~ /[A-Za-z0-9_$]/ || character ~ /[\200-\377]/
    }
    function is_dollar_tag_continuation(character) {
      return character ~ /[A-Za-z0-9_]/ || character ~ /[\200-\377]/
    }
    function dollar_delimiter(line, position,  previous, next_dollar, tag, candidate, tag_index, tag_character) {
      if (substr(line, position, 1) != "$") return ""
      if (position > 1) {
        previous = substr(line, position - 1, 1)
        if (is_identifier_continuation(previous)) return ""
      }
      next_dollar = index(substr(line, position + 1), "$")
      if (next_dollar == 0) return ""
      candidate = substr(line, position, next_dollar + 1)
      tag = substr(candidate, 2, length(candidate) - 2)
      if (tag == "") return candidate
      if (!is_identifier_start(substr(tag, 1, 1))) return ""
      for (tag_index = 2; tag_index <= length(tag); tag_index += 1) {
        tag_character = substr(tag, tag_index, 1)
        if (!is_dollar_tag_continuation(tag_character)) return ""
      }
      return candidate
    }
    {
      line = $0
      sub(/\r$/, "", line)
      if (copy_data) {
        if (line == "\\.") copy_data = 0
        next
      }
      for (index_in_line = 1; index_in_line <= length(line);) {
        rest = substr(line, index_in_line)
        character = substr(line, index_in_line, 1)

        if (dollar_quote != "") {
          if (index(rest, dollar_quote) == 1) {
            index_in_line += length(dollar_quote)
            dollar_quote = ""
          } else {
            index_in_line += 1
          }
          continue
        }

        if (quote != "") {
          escaped_quote = quote == "\047" && escape_string && character == quote && consecutive_backslashes % 2 == 1
          if (escaped_quote) {
            index_in_line += 1
            consecutive_backslashes = 0
          } else if (character == quote && substr(line, index_in_line + 1, 1) == quote) {
            index_in_line += 2
            consecutive_backslashes = 0
          } else {
            index_in_line += 1
            if (character == quote) {
              quote = ""
              escape_string = 0
            }
            if (character == "\\") consecutive_backslashes += 1
            else consecutive_backslashes = 0
          }
          continue
        }

        if (block_comment_depth > 0) {
          if (index(rest, "/*") == 1) {
            block_comment_depth += 1
            index_in_line += 2
          } else if (index(rest, "*/") == 1) {
            block_comment_depth -= 1
            index_in_line += 2
          } else {
            index_in_line += 1
          }
          continue
        }

        if (index(rest, "--") == 1) break
        if (index(rest, "/*") == 1) {
          block_comment_depth = 1
          statement = statement " "
          index_in_line += 2
          continue
        }
        previous_character = index_in_line > 1 ? substr(line, index_in_line - 1, 1) : ""
        if ((character == "E" || character == "e") && substr(line, index_in_line + 1, 1) == "\047" &&
            !is_identifier_continuation(previous_character)) {
          quote = "\047"
          escape_string = 1
          consecutive_backslashes = 0
          statement = statement " "
          index_in_line += 2
          continue
        }
        if (character == "\047" || character == "\042") {
          quote = character
          escape_string = 0
          consecutive_backslashes = 0
          statement = statement " "
          index_in_line += 1
          continue
        }
        delimiter = dollar_delimiter(line, index_in_line)
        if (delimiter != "") {
          dollar_quote = delimiter
          statement = statement " "
          index_in_line += length(delimiter)
          continue
        }
        if (character == "\\") reject()
        if (character == ";") {
          check_statement()
        } else {
          statement = statement character
        }
        index_in_line += 1
      }
      if (quote != "") consecutive_backslashes = 0
      statement = statement "\n"
    }
    END {
      if (copy_data && unsafe == 0) reject()
      check_statement()
      exit unsafe ? 1 : 0
    }
  ' "$1"
}

for migration_file in "$migrations_dir"/*.sql; do
  migration_id="$(basename "$migration_file" .sql)"
  if ! migration_source_is_safe "$migration_file"; then
    printf 'Unsafe migration source %s: top-level psql meta-command or transaction control is not permitted.\n' "$migration_id" >&2
    exit 1
  fi

  migration_id="$(basename "$migration_file" .sql)"
  checksum="$(migration_checksum "$migration_file")"

  # One session and one transaction: either migration DDL and its ledger row commit
  # together, or neither does. The advisory transaction lock serializes competing
  # migrate services before they create or recheck this migration's ledger state.
  {
    printf 'BEGIN ISOLATION LEVEL READ COMMITTED;\n'
    printf "SELECT pg_advisory_xact_lock(hashtext('eow:schema_migrations')) AS migration_lock_acquired \\gset\n"
    printf 'CREATE TABLE IF NOT EXISTS schema_migrations (\n'
    printf '  id text PRIMARY KEY,\n'
    printf '  checksum text NOT NULL,\n'
    printf '  applied_at timestamptz NOT NULL DEFAULT now()\n'
    printf ');\n'
    printf 'SELECT EXISTS (SELECT FROM schema_migrations WHERE id = :%s AND checksum IS DISTINCT FROM :%s) AS migration_checksum_mismatch, NOT EXISTS (SELECT FROM schema_migrations WHERE id = :%s) AS migration_pending \\gset\n' "'id'" "'checksum'" "'id'"
    printf '\\if :migration_checksum_mismatch\n'
    printf '-- Published migration :id changed; add a forward migration instead.\n'
    printf "SELECT 'Published migration ' || :%s || ' changed; add a forward migration instead.' AS migration_error \\gset\n" "'id'"
    printf "SELECT :'migration_error'::text::integer;\n"
    printf '\\endif\n'
    printf '\\if :migration_pending\n'
    printf 'SELECT txid_current() AS migration_outer_transaction_id \\gset\n'
    printf '\\i :migration_file\n'
    printf 'SELECT txid_current() = :%s::bigint AS migration_outer_transaction_intact \\gset\n' "'migration_outer_transaction_id'"
    printf '\\if :migration_outer_transaction_intact\n'
    printf 'INSERT INTO schema_migrations(id, checksum) VALUES (:%s, :%s);\n' "'id'" "'checksum'"
    printf '\\else\n'
    printf 'SELECT %s::text::integer;\n' "'A migration ended migrate.sh transaction before its ledger record'"
    printf '\\endif\n'
    printf '\\endif\n'
    printf 'COMMIT;\n'
    printf '\\if :migration_pending\n'
    printf '\\echo Migration :id applied.\n'
    printf '\\else\n'
    printf '\\echo Migration :id already applied.\n'
    printf '\\endif\n'
  } | psql -X -w -v ON_ERROR_STOP=1 -v app_password="$EOW_POSTGRES_APP_PASSWORD" -v id="$migration_id" -v checksum="$checksum" -v migration_file="$migration_file"
done
