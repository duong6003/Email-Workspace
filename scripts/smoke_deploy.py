from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time
import urllib.request
from dataclasses import asdict, dataclass
from typing import Any


@dataclass
class CheckResult:
    case: str
    name: str
    ok: bool
    detail: str


def http_json(url: str, expected_status: str | None = None) -> tuple[bool, str]:
    last = 'not attempted'
    for _ in range(20):
        try:
            with urllib.request.urlopen(url, timeout=3) as response:
                body = response.read().decode('utf-8')
                if not 200 <= response.status < 300:
                    last = f'HTTP {response.status}'
                elif expected_status is None:
                    return True, f'{url} ({response.status})'
                else:
                    payload = json.loads(body)
                    if payload.get('status') == expected_status:
                        return True, f'{url} ({response.status}, status={expected_status})'
                    last = f"status={payload.get('status')!r}"
        except Exception as error:  # noqa: BLE001 - operator-facing smoke detail
            last = str(error)
        time.sleep(1)
    return False, f'{url}: {last}'


def compose_command() -> list[str]:
    configured = os.environ.get('EOW_COMPOSE_COMMAND')
    if configured:
        return configured.split()
    if subprocess.run(['docker', 'compose', 'version'], capture_output=True).returncode == 0:
        return ['docker', 'compose']
    return ['docker-compose']


def container_checks(env_file: str) -> list[CheckResult]:
    # `-a` is load-bearing, not defensive. Compose v2's `ps -q` lists only
    # RUNNING containers, so the one-shot `migrate` service -- which has
    # correctly exited 0 by the time a deployment is up -- never appears, and
    # the DEPLOY-002 migration-exit check can never pass. Compose v1's `ps -q`
    # did list exited containers, which is why this went unnoticed on a host
    # that had only the v1 binary. docs/deployment/quick-deploy.md documents
    # the v2 form (`docker compose`), so v2 is the contract.
    command = [*compose_command(), '--env-file', env_file, 'ps', '-a', '-q']
    process = subprocess.run(command, capture_output=True, text=True)
    if process.returncode != 0:
        return [CheckResult('DEPLOY-002', 'compose-services', False, process.stderr.strip() or 'compose ps failed')]
    container_ids = [line for line in process.stdout.splitlines() if line]
    if not container_ids:
        return [CheckResult('DEPLOY-002', 'compose-services', False, 'no Compose containers found')]

    states: dict[str, str] = {}
    migrate_ok = False
    for container_id in container_ids:
        inspected = subprocess.run(['docker', 'inspect', container_id], capture_output=True, text=True)
        if inspected.returncode != 0:
            return [CheckResult('DEPLOY-002', 'compose-services', False, inspected.stderr.strip())]
        container = json.loads(inspected.stdout)[0]
        service = container['Config']['Labels'].get('com.docker.compose.service', container['Name'].lstrip('/'))
        state = container['State']
        status = state.get('Health', {}).get('Status') or state['Status']
        states[service] = status
        if service == 'migrate':
            migrate_ok = state['Status'] == 'exited' and state.get('ExitCode') == 0

    # `mailpit` is deliberately absent from this list. It is a development mail
    # catcher gated behind the `dev` Compose profile, so a production bring-up
    # legitimately has no mailpit container and must not fail DEPLOY-002 for it.
    # When the dev profile IS enabled it still has to be up, hence the
    # present-then-check rather than an unconditional skip.
    long_running = ['postgres', 'redis', 'api', 'worker', 'scheduler', 'web']
    if 'mailpit' in states:
        long_running.append('mailpit')
    services_ok = all(states.get(service) in {'healthy', 'running'} for service in long_running)
    return [
        CheckResult('DEPLOY-002', 'compose-services', services_ok, json.dumps(states, sort_keys=True)),
        CheckResult('DEPLOY-002', 'migration-exit', migrate_ok, f"migrate={states.get('migrate', 'missing')}, exit0={migrate_ok}"),
    ]


def run(case: str | None, env_file: str) -> list[CheckResult]:
    base = os.environ.get('EOW_SMOKE_BASE_URL', 'http://localhost:8080').rstrip('/')
    checks: list[CheckResult] = []
    if case in (None, 'DEPLOY-002'):
        checks.extend(container_checks(env_file))
    if case in (None, 'DEPLOY-003'):
        for name, path, expected in [
            ('edge-liveness', '/healthz', None),
            ('api-liveness', '/api/v1/health', 'ready'),
            ('api-readiness', '/api/v1/health/ready', 'ready'),
        ]:
            ok, detail = http_json(f'{base}{path}', expected)
            checks.append(CheckResult('DEPLOY-003', name, ok, detail))
    if case == 'DEPLOY-006':
        ok, detail = http_json(f'{base}/api/v1/health/ready', 'ready')
        checks.append(CheckResult('DEPLOY-006', 'api-readiness', ok, detail))
    return checks


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument('--json', action='store_true')
    parser.add_argument('--case', choices=[f'DEPLOY-{number:03d}' for number in range(1, 11)])
    parser.add_argument('--env-file', default='.env.deploy.local' if os.path.exists('.env.deploy.local') else '.env')
    args = parser.parse_args()
    results = run(args.case, args.env_file)
    failures = [result for result in results if not result.ok]
    if args.json:
        print(json.dumps({'status': 'failed' if failures else 'ok', 'checks': [asdict(result) for result in results]}, indent=2))
    else:
        for result in results:
            print(f"{'PASS' if result.ok else 'FAIL'} {result.case} {result.name}: {result.detail}")
    if failures:
        print('Failed checks: ' + ', '.join(f'{result.case}/{result.name}' for result in failures), file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
