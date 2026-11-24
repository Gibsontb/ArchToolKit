import { error,              } from '../core/findings.js';
                                                     
import { blk, dat, e, jsonencode, output, res, x } from '../terraform/blueprints/migration/common.js';
import { awsServiceModule, awsServicePartition, awsServiceRegion } from './aws-service-module.js';
export const AWS_BEDROCK_SERVICE = {
  id: 'aws_service_bedrock_inference', label: 'Integrate a role with regional Bedrock text inference',
  description: 'Check an on-demand foundation model, add exact-model invocation permissions to an existing role and export a credential-free Converse client with optional existing guardrail.',
  emits: ['aws_iam_role_policy'],
  inputs: [
    awsServiceRegion,
    { id: 'name', label: 'Integration policy name', control: 'text' },
    { id: 'role', label: 'Existing application IAM role ARN', control: 'text', hint: 'Role in the deployment account; trust and application credential delivery remain with the existing workload.' },
    { id: 'model', label: 'Regional foundation model ID', control: 'text', hint: 'Exact model ID from the regional Bedrock model list. Must support text, on-demand invocation and Converse; inference profiles/cross-region routing are separate workflows.' },
    { id: 'mode', label: 'Response mode', control: 'select', default: 'SYNC', options: [{ value: 'SYNC', label: 'Converse — complete response' }, { value: 'STREAM', label: 'ConverseStream — streaming response' }] },
    { id: 'tokens', label: 'Example maximum output tokens', control: 'number', default: 256, hint: '1–4096 in this client example, within the chosen model limit. This is not an account spending ceiling.' },
    { id: 'guardrail', label: 'Existing regional guardrail ARN', control: 'text', hint: 'Optional guardrail in this account/region; if supplied, the example client sends its configured version on every request.' },
    { id: 'guardrail_version', label: 'Existing guardrail version', control: 'text', hint: 'Required with a guardrail ARN; use a numbered published version or DRAFT for development.' },
  ],
  build(values)                                      {
    const findings            = [];
    const reject = (path        , message        ) => findings.push(error('aws.bedrock.' + path, message, { path }));
    const region = String(values.aws_region ?? ''), partition = awsServicePartition(region), name = String(values.name ?? '').trim(), role = String(values.role ?? '').trim(), model = String(values.model ?? '').trim(), mode = String(values.mode ?? ''), tokens = Number(values.tokens), guardrail = String(values.guardrail ?? '').trim(), guardrailVersion = guardrail ? String(values.guardrail_version ?? '').trim() : '';
    const roleMatch = new RegExp('^arn:' + partition + ':iam::(\\d{12}):role/([A-Za-z0-9+=,.@_/-]*[A-Za-z0-9+=,.@_-])$').exec(role);
    if (!/^[A-Za-z][A-Za-z0-9_-]{0,99}$/.test(name)) reject('name', 'Use a letter followed by up to 99 letters, digits, underscores or hyphens.');
    if (!roleMatch) reject('role', 'Use an existing application role ARN in the selected partition.');
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(model)) reject('model', 'Enter the exact regional foundation model ID, not an ARN or inference profile.');
    if (!['SYNC', 'STREAM'].includes(mode)) reject('mode', 'Choose complete or streaming responses.');
    if (!Number.isInteger(tokens) || tokens < 1 || tokens > 4096) reject('tokens', 'Use 1–4096 output tokens within the selected model limit.');
    if (guardrail && !new RegExp('^arn:' + partition + ':bedrock:' + region + ':' + (roleMatch?.[1] ?? '\\d{12}') + ':guardrail/[a-z0-9]+$').test(guardrail)) reject('guardrail', 'Use an existing guardrail ARN in the application role account and selected region.');
    if (guardrail && !/^(?:DRAFT|[1-9]\d{0,7})$/.test(guardrailVersion)) reject('guardrail_version', 'Use an existing published numeric guardrail version or DRAFT for development.');
    const result = awsServiceModule(region, [
      dat('aws_caller_identity', 'current', {}), dat('aws_bedrock_foundation_model', 'selected', { model_id: model }),
      res('aws_iam_role_policy', 'inference', { name, role: roleMatch?.[2]?.split('/').at(-1) ?? '', policy: x(jsonencode({ Version: '2012-10-17', Statement: [
        { Effect: 'Allow', Action: [mode === 'STREAM' ? 'bedrock:InvokeModelWithResponseStream' : 'bedrock:InvokeModel'], Resource: e('data.aws_bedrock_foundation_model.selected.model_arn') },
        ...(guardrail ? [{ Effect: 'Allow', Action: ['bedrock:GetGuardrail', 'bedrock:ApplyGuardrail'], Resource: guardrail }] : []),
      ] })) }, [blk('lifecycle', {}, [blk('precondition', { condition: x('data.aws_caller_identity.current.account_id == ' + JSON.stringify(roleMatch?.[1] ?? '') + ' && contains(data.aws_bedrock_foundation_model.selected.input_modalities, "TEXT") && contains(data.aws_bedrock_foundation_model.selected.output_modalities, "TEXT") && contains(data.aws_bedrock_foundation_model.selected.inference_types_supported, "ON_DEMAND")' + (mode === 'STREAM' ? ' && data.aws_bedrock_foundation_model.selected.response_streaming_supported' : '')), error_message: 'Use this account\'s application role and a regional on-demand text model supporting the selected response mode.' })])]),
      output('model_arn', 'data.aws_bedrock_foundation_model.selected.model_arn'), output('model_id', 'data.aws_bedrock_foundation_model.selected.model_id'), output('application_role_arn', JSON.stringify(role)),
    ], `# Regional Bedrock text inference integration

## Prepare
Select an available regional foundation model that supports text, on-demand inference and Converse. Model metadata verifies text/on-demand/streaming capabilities during plan; it does not expose a Converse compatibility flag, so verify that separately in the model's supported-API documentation. Complete any required provider terms/model access/marketplace permissions through the account owner; this package does not subscribe to products or accept terms. Inference profiles (including cross-region routing), provisioned/custom/imported models, agents and RAG are outside this scoped integration.

Confirm the application role trust, temporary-credential delivery, network path to the regional Bedrock runtime, applicable endpoint/SCP policies, data-owner handling rules and approved model/service authorization. ${guardrail ? 'Review the existing guardrail/version and its availability before use. The example sends it on every request and grants only its Get/Apply permissions.' : 'No guardrail is configured; add the approved guardrail/workflow where required before processing governed data.'} Guardrails are content controls, not an ATO or security-classification decision. This inline allow policy is additive; other role policies can grant broader invocation or guardrail bypass. Account/IAM owners must enforce any mandatory perimeter/guardrail restrictions independently.

## Implement
Run terraform init, terraform validate and terraform plan -out=service.tfplan. Review the exact model ARN, invocation action, role, guardrail grants and account; apply the reviewed plan. This creates only a scoped role policy, not a model deployment or an inference request. Install an approved pinned boto3 version satisfying requirements.txt in the client environment. Run CLIENT.py through the intended application's existing temporary credentials; it never embeds/assumes a role or stores access keys. With no --text-file it sends only a short demonstration prompt. Supply a local text file only after authorizing its data for this model/region.

## Verify
Use approved nonsensitive test text, run the client, and verify role identity, actual model, response, usage and request metadata in the appropriate monitoring systems. The client uses the regional runtime endpoint with SDK TLS verification. Check denied calls under an unauthorized identity/model and any required network/guardrail restrictions. Model context/output limits and API support may differ; adjust within the service/model documentation. Monitor invocation errors, latency, throttling and input/output token cost. The example maximum output count does not cap input size, concurrency or total spend. Invocation content logging, prompt retention and application logs must be deliberately configured under the data-owner policy; this package does not enable them.

## Recovery
Restore the prior reviewed role policy/model configuration if integration fails; disabling this allow does not revoke permissions granted elsewhere. Stop application traffic and preserve only approved incident evidence under retention rules. Model changes can alter output behavior; verify application quality/safety and accepted versions before cutover. Generated examples contain no credentials or user data. Local generation/validation makes no inference request, accepts no terms and incurs no model invocation charges.

https://docs.aws.amazon.com/bedrock/latest/userguide/inference-prereq.html
https://docs.aws.amazon.com/bedrock/latest/userguide/conversation-inference.html
`, findings);
    const config = { region, model, mode, tokens, ...(guardrail ? { guardrail, guardrail_version: guardrailVersion } : {}) };
    return { ...result, files: { ...result.files, 'client-config.json': JSON.stringify(config, null, 2) + '\n', 'requirements.txt': 'boto3>=1.34.131,<2\n', 'CLIENT.py': `"""Explicitly run this example only with data approved for the selected model/region."""
import argparse
import json
from pathlib import Path
import boto3

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--text-file", type=Path)
    args = parser.parse_args()
    config = json.loads(Path(__file__).with_name("client-config.json").read_text(encoding="utf-8"))
    text = args.text_file.read_text(encoding="utf-8") if args.text_file else "Reply with hello."
    request = {"modelId": config["model"], "messages": [{"role": "user", "content": [{"text": text}]}], "inferenceConfig": {"maxTokens": config["tokens"]}}
    if config.get("guardrail"):
        request["guardrailConfig"] = {"guardrailIdentifier": config["guardrail"], "guardrailVersion": config["guardrail_version"]}
    client = boto3.client("bedrock-runtime", region_name=config["region"])
    if config["mode"] == "STREAM":
        response = client.converse_stream(**request)
        for event in response["stream"]:
            if "contentBlockDelta" in event:
                print(event["contentBlockDelta"].get("delta", {}).get("text", ""), end="", flush=True)
            elif "metadata" in event:
                print("\\nUsage:", json.dumps(event["metadata"].get("usage", {})))
            elif any(key.endswith("Exception") for key in event):
                raise RuntimeError("Bedrock stream returned an error: " + json.dumps(event))
        print()
    else:
        response = client.converse(**request)
        for block in response["output"]["message"]["content"]:
            if "text" in block:
                print(block["text"])
        print("Usage:", json.dumps(response.get("usage", {})))

if __name__ == "__main__":
    main()
` } };
  },
}                    ;
