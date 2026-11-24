/** Generated-client checks with a local boto3 stub. No credentials/network/model calls. */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { defaultValues } from '../src/kit/blueprint.ts';
import { AWS_BEDROCK_SERVICE } from '../src/cloud/aws-bedrock-service.ts';
import { WORK_TMP } from './work.mjs';
const work = mkdtempSync(join(WORK_TMP, 'bedrock-client-test-'));
const cases = [{ mode: 'SYNC' }, { mode: 'SYNC', guardrail: true }, { mode: 'SYNC', text: true }, { mode: 'STREAM' }, { mode: 'STREAM', guardrail: true }, { mode: 'STREAM', error: true }];
const stub = [
  'import json',
  'from pathlib import Path',
  'ROOT = Path(__file__).parent',
  'CONFIG = json.loads((ROOT / "client-config.json").read_text())',
  'CASE = json.loads((ROOT / "case.json").read_text())',
  'class Stub:',
  '    def check(self, request, mode):',
  '        assert mode == CONFIG["mode"], "Wrong SDK method"',
  '        assert request["modelId"] == CONFIG["model"]',
  '        assert request["inferenceConfig"] == {"maxTokens": 256}',
  '        text = "Approved mock text — no cloud request." if CASE.get("text") else "Reply with hello."',
  '        assert request["messages"] == [{"role": "user", "content": [{"text": text}]}]',
  '        if CONFIG.get("guardrail"):',
  '            assert request["guardrailConfig"] == {"guardrailIdentifier": CONFIG["guardrail"], "guardrailVersion": "2"}',
  '        else:',
  '            assert "guardrailConfig" not in request',
  '        (ROOT / "mock-request.json").write_text(json.dumps(request))',
  '    def converse(self, **request):',
  '        self.check(request, "SYNC")',
  '        return {"output": {"message": {"content": [{"text": "mock hello"}]}}, "usage": {"outputTokens": 2}}',
  '    def converse_stream(self, **request):',
  '        self.check(request, "STREAM")',
  '        events = [{"contentBlockDelta": {"delta": {"text": "mock hello"}}}]',
  '        events.append({"internalServerException": {"message": "mock failure"}} if CASE.get("error") else {"metadata": {"usage": {"outputTokens": 2}}})',
  '        return {"stream": iter(events)}',
  'def client(service, **options):',
  '    assert service == "bedrock-runtime"',
  '    assert options == {"region_name": "us-east-1"}, "Unexpected credentials/endpoint/TLS override"',
  '    return Stub()',
].join('\n');
for (const [index, fixture] of cases.entries()) {
  const directory = join(work, String(index)); mkdirSync(directory);
  const result = AWS_BEDROCK_SERVICE.build({ ...defaultValues(AWS_BEDROCK_SERVICE), aws_region: 'us-east-1', name: 'mock-inference', role: 'arn:aws:iam::123456789012:role/Application', model: 'amazon.nova-micro-v1:0', mode: fixture.mode, ...(fixture.guardrail ? { guardrail: 'arn:aws:bedrock:us-east-1:123456789012:guardrail/abc123', guardrail_version: '2' } : {}) });
  assert.deepEqual(result.findings, []);
  for (const name of ['CLIENT.py', 'client-config.json']) writeFileSync(join(directory, name), result.files[name]);
  writeFileSync(join(directory, 'boto3.py'), stub);
  writeFileSync(join(directory, 'case.json'), JSON.stringify(fixture));
  writeFileSync(join(directory, 'message.txt'), 'Approved mock text — no cloud request.');
  const check = spawnSync(process.env.PYTHON_PATH || 'python', [join(directory, 'CLIENT.py'), ...(fixture.text ? ['--text-file', join(directory, 'message.txt')] : [])], { cwd: directory, encoding: 'utf8', timeout: 30000, windowsHide: true });
  if (check.error) throw check.error;
  if (fixture.error) { assert.notEqual(check.status, 0); assert.match(check.stderr, /Bedrock stream returned an error/); }
  else { assert.equal(check.status, 0, check.stderr); assert.match(check.stdout, /mock hello/); assert.match(check.stdout, /outputTokens/); }
  assert.equal(JSON.parse(readFileSync(join(directory, 'mock-request.json'), 'utf8')).modelId, 'amazon.nova-micro-v1:0');
}
console.log('Passed six local client cases: sync/stream, guardrails, UTF-8 text and stream errors. No model API called.');
console.log('Mock artifacts: ' + work);
