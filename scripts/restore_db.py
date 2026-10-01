from __future__ import annotations

import argparse
import hashlib
import json
import os
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path


def env_values(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    for line in path.read_text(encoding='utf-8').splitlines():
        if line and not line.startswith('#') and '=' in line:
            key, value = line.split('=', 1)
            values[key] = value
    return values


def compose_command() -> list[str]:
    if subprocess.run(['docker', 'compose', 'version'], capture_output=True).returncode == 0:
        return ['docker', 'compose']
    return ['docker-compose']


def wait_postgres(command: list[str], environment: dict[str, str]) -> None:
    deadline = time.monotonic() + 120
    while time.monotonic() < deadline:
        ready = subprocess.run([*command, 'exec', '-T', 'postgres', 'pg_isready', '-U', 'eow', '-d', 'eow'], capture_output=True, env=environment)
        if ready.returncode == 0:
            return
        time.sleep(2)
    raise RuntimeError('isolated PostgreSQL did not become ready within 120 seconds')


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument('--env-file', default='.env')
    parser.add_argument('--dump', required=True)
    parser.add_argument('--project', required=True)
    args = parser.parse_args()

    env_file = Path(args.env_file).resolve()
    values = env_values(env_file)
    source_project = values.get('COMPOSE_PROJECT_NAME') or Path.cwd().name
    if args.project == source_project:
        print(f'restore refused: project {args.project!r} is the source project', file=sys.stderr)
        return 2
    dump = Path(args.dump).resolve()
    metadata_path = Path(str(dump) + '.json')
    metadata = json.loads(metadata_path.read_text(encoding='utf-8'))
    actual_sha = hashlib.sha256(dump.read_bytes()).hexdigest()
    if actual_sha != metadata['sha256']:
        print('restore refused: dump SHA-256 does not match its sidecar', file=sys.stderr)
        return 2

    restore_env = dict(os.environ)
    restore_env['EOW_POSTGRES_BIND'] = '127.0.0.1'
    restore_env['EOW_POSTGRES_PORT'] = '0'
    restore_env['EOW_REDIS_PORT'] = '0'
    restore_env['EOW_MAILPIT_PORT'] = '0'
    restore_env['EOW_MAILPIT_SMTP_PORT'] = '0'
    restore_env['EOW_HTTP_PORT'] = '0'
    command = [*compose_command(), '-p', args.project, '--env-file', str(env_file)]
    started = time.monotonic()
    try:
        subprocess.run([*command, 'down', '-v'], capture_output=True, env=restore_env)
        subprocess.run([*command, 'up', '-d', 'postgres'], check=True, env=restore_env)
        wait_postgres(command, restore_env)
        restore = subprocess.run(
            [*command, 'exec', '-T', 'postgres', 'pg_restore', '-U', values.get('EOW_POSTGRES_USER', 'eow'), '-d', metadata['database'], '--clean', '--if-exists', '--no-owner', '--no-privileges'],
            stdin=dump.open('rb'),
            stderr=subprocess.PIPE,
            env=restore_env,
        )
        if restore.returncode != 0:
            raise RuntimeError(restore.stderr.decode('utf-8', errors='replace').strip() or 'pg_restore failed')
        query = subprocess.run(
            [*command, 'exec', '-T', 'postgres', 'psql', '-U', values.get('EOW_POSTGRES_USER', 'eow'), '-d', metadata['database'], '-At', '-c',
             "SELECT json_build_object('tenant', (SELECT count(*) FROM tenant), 'campaign', (SELECT count(*) FROM campaign), 'recipient', (SELECT count(*) FROM recipient), 'message_attempt', (SELECT count(*) FROM message_attempt), 'schema_migrations', (SELECT count(*) FROM schema_migrations));"],
            capture_output=True,
            text=True,
            check=True,
            env=restore_env,
        )
        counts = json.loads(query.stdout.strip())
        if counts != metadata['counts']:
            raise RuntimeError(f"restored counts differ: expected {metadata['counts']}, got {counts}")
        now = datetime.now(timezone.utc)
        backup_time = datetime.fromisoformat(metadata['timestamp_utc'])
        result = {
            'status': 'ok',
            'project': args.project,
            'verified_counts': counts,
            'rto_seconds': round(time.monotonic() - started, 3),
            'rpo_age_seconds': round((now - backup_time).total_seconds(), 3),
        }
        print(json.dumps(result, indent=2))
        return 0
    except Exception as error:
        print(f'restore failed: {error}', file=sys.stderr)
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
