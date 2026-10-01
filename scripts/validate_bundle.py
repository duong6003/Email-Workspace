from pathlib import Path
import json, subprocess, sys
root=Path(__file__).resolve().parents[1]
required=['AGENTS.md','project.manifest.yaml','docs/index.yaml','pnpm-lock.yaml','.agents/orchestration-policy.yaml','.agents/approval-policy.yaml','.agents/agent-loop.yaml','.agents/agent-graph.yaml','.agents/agent-schedule.yaml','.agents/schemas/run-state.schema.json','.agents/schemas/completion-report.schema.json','.agents/runs/example/state.json','docs/architecture/runtime-orchestration.md','contracts/openapi.yaml','contracts/asyncapi.yaml','database/migrations/001_initial.sql','database/migrate.sh','catalog/ba-rules.json','catalog/test-cases.json','catalog/deployment-test-cases.json','apps/web/package.json','apps/api/package.json','apps/worker/package.json','apps/scheduler/package.json','packages/runtime-orchestration/package.json','compose.yaml','Dockerfile','.dockerignore','.env.deploy.example','deploy/nginx/default.conf','docs/deployment/quick-deploy.md','docs/deployment/environment-variables.md','docs/deployment/operations.md','docs/deployment/acceptance-tests.md','docs/adr/adr-024-one-command-container-deployment.md','scripts/smoke_deploy.py','scripts/ui_handoff.py','scripts/test_ui_handoff.py','scripts/build_manifest.py','design-reference/README.md','design-reference/ui-source-contract.yaml','design-reference/visual-acceptance.md','design-reference/screen-catalog.template.yaml','docs/delivery/start-coding-with-agent.md']
missing=[p for p in required if not (root/p).is_file()]
counts={'rules':len(json.loads((root/'catalog/ba-rules.json').read_text(encoding='utf-8'))),'tests':len(json.loads((root/'catalog/test-cases.json').read_text(encoding='utf-8'))),'gaps':len(json.loads((root/'catalog/business-gaps.json').read_text(encoding='utf-8')))}
expected={'rules':118,'tests':159,'gaps':75}
json_files=['.agents/schemas/run-state.schema.json','.agents/schemas/completion-report.schema.json','.agents/runs/example/state.json']
json_errors=[]
for relative in json_files:
  try: json.loads((root/relative).read_text(encoding='utf-8'))
  except Exception as error: json_errors.append(f'{relative}: {error}')
policy_text='\n'.join((root/p).read_text(encoding='utf-8') for p in ['.agents/orchestration-policy.yaml','.agents/agent-loop.yaml','.agents/agent-graph.yaml','.agents/agent-schedule.yaml'])
separation_errors=[]
if 'coding_agent_only' not in policy_text: separation_errors.append('agent scope marker missing')
if 'email_campaign_business_schedule' not in policy_text: separation_errors.append('runtime exclusion missing')
deployment_errors=[]
compose=(root/'compose.yaml').read_text(encoding='utf-8')
env_example=(root/'.env.deploy.example').read_text(encoding='utf-8')
env_docs=(root/'docs/deployment/environment-variables.md').read_text(encoding='utf-8')
required_env=['EOW_POSTGRES_PASSWORD','EOW_REDIS_PASSWORD','EOW_SESSION_SECRET','EOW_SENDER_CREDENTIAL_KEY','EOW_WEB_ORIGIN','EOW_WORKER_CONCURRENCY','EOW_SCHEDULER_TICK_MS','EOW_SMTP_HOST','EOW_SMTP_PORT']
for key in required_env:
  if key not in env_example: deployment_errors.append(f'{key} missing from env example')
  if key not in env_docs: deployment_errors.append(f'{key} missing from env docs')
for service in ['postgres:','redis:','mailpit:','migrate:','api:','worker:','scheduler:','web:']:
  if service not in compose: deployment_errors.append(f'{service} missing from compose')
if 'service_completed_successfully' not in compose or '--wait' not in (root/'docs/deployment/quick-deploy.md').read_text(encoding='utf-8'):
  deployment_errors.append('health-gated one-command deployment contract missing')
ui_check=subprocess.run([sys.executable,str(root/'scripts/ui_handoff.py'),'status','--allow-pending'],cwd=root,text=True,capture_output=True)
ui_errors=[] if ui_check.returncode==0 else [ui_check.stderr or ui_check.stdout]
agent_text=(root/'AGENTS.md').read_text(encoding='utf-8')
for marker in ['design-reference/ui-handoff-v2/source/','python scripts/ui_handoff.py status','visual equivalence']:
  if marker not in agent_text: ui_errors.append(f'AGENTS.md UI marker missing: {marker}')
if missing or counts!=expected or json_errors or separation_errors or deployment_errors or ui_errors:
  print({'missing':missing,'counts':counts,'expected':expected,'json_errors':json_errors,'separation_errors':separation_errors,'deployment_errors':deployment_errors,'ui_errors':ui_errors});sys.exit(1)
print({'status':'ok','counts':counts,'required_files':len(required),'agent_runtime_separation':'ok','deployment_contract':'ok','ui_handoff_scaffold':'ok'})
