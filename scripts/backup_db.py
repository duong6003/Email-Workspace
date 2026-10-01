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


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument('--env-file', default='.env')
    parser.add_argument('--project')
    parser.add_argument('--out', required=True)
    args = parser.parse_args()

    env_file = Path(args.env_file).resolve()
    values = env_values(env_file)
    project = args.project or values.get('COMPOSE_PROJECT_NAME') or Path.cwd().name
    database = values.get('EOW_POSTGRES_DB', 'eow')
    output = Path(args.out).resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = output.with_suffix(output.suffix + '.partial')
    metadata_path = Path(str(output) + '.json')
    command = [*compose_command(), '-p', project, '--env-file', str(env_file)]
    started = time.monotonic()
    timestamp = datetime.now(timezone.utc)

    try:
        with temporary.open('wb') as handle:
            process = subprocess.run(
                [*command, 'exec', '-T', 'postgres', 'sh', '-lc', 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc'],
                stdout=handle,
                stderr=subprocess.PIPE,
            )
        if process.returncode != 0:
            raise RuntimeError(process.stderr.decode('utf-8', errors='replace').strip() or 'pg_dump failed')
        verify = subprocess.run(
            [*command, 'exec', '-T', 'postgres', 'pg_restore', '--list'],
            stdin=temporary.open('rb'),
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
        )
        if verify.returncode != 0:
            raise RuntimeError(verify.stderr.decode('utf-8', errors='replace').strip() or 'pg_restore --list failed')
        query = subprocess.run(
            [*command, 'exec', '-T', 'postgres', 'psql', '-U', values.get('EOW_POSTGRES_USER', 'eow'), '-d', database, '-At', '-c',
             "SELECT json_build_object('tenant', (SELECT count(*) FROM tenant), 'campaign', (SELECT count(*) FROM campaign), 'recipient', (SELECT count(*) FROM recipient), 'message_attempt', (SELECT count(*) FROM message_attempt), 'schema_migrations', (SELECT count(*) FROM schema_migrations));"],
            capture_output=True,
            text=True,
            check=True,
        )
        counts = json.loads(query.stdout.strip())
        temporary.replace(output)
        payload = {
            'timestamp_utc': timestamp.isoformat(),
            'project': project,
            'database': database,
            'dump_size_bytes': output.stat().st_size,
            'sha256': hashlib.sha256(output.read_bytes()).hexdigest(),
            'duration_seconds': round(time.monotonic() - started, 3),
            'counts': counts,
        }
        metadata_path.write_text(json.dumps(payload, indent=2) + '\n', encoding='utf-8')
        print(json.dumps({'status': 'ok', 'dump': str(output), 'metadata': str(metadata_path), **payload}, indent=2))
        return 0
    except Exception as error:
        temporary.unlink(missing_ok=True)
        output.unlink(missing_ok=True)
        metadata_path.unlink(missing_ok=True)
        print(f'backup failed: {error}', file=sys.stderr)
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
