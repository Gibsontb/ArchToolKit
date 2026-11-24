export function awsMskClientFiles(region: string, topics: string[], groups: string[], access: string, role: string): Record<string, string> {
    const check = [
      'import json, pathlib, ssl, subprocess',
      'from kafka import KafkaConsumer',
      'from kafka.sasl.oauth import AbstractTokenProvider',
      'from aws_msk_iam_sasl_signer import MSKAuthTokenProvider',
      'config = json.loads((pathlib.Path(__file__).resolve().parent / "CLIENT-CONFIG.json").read_text(encoding="utf-8"))',
      'brokers = subprocess.check_output(["terraform", "output", "-raw", "bootstrap_brokers"], text=True).strip().split(",")',
      'if not brokers or any(not broker.endswith(":9098") for broker in brokers): raise RuntimeError("Missing IAM bootstrap brokers")',
      'class TokenProvider(AbstractTokenProvider):',
      '    def token(self):',
      '        token, expiry = MSKAuthTokenProvider.generate_auth_token(config["region"])',
      '        return token',
      'context = ssl.create_default_context()',
      'context.minimum_version = ssl.TLSVersion.TLSv1_2',
      'consumer = KafkaConsumer(bootstrap_servers=brokers, security_protocol="SASL_SSL", sasl_mechanism="OAUTHBEARER", sasl_oauth_token_provider=TokenProvider(), ssl_context=context, ssl_check_hostname=True, enable_auto_commit=False, group_id=None, allow_auto_create_topics=False, request_timeout_ms=30000, api_version_auto_timeout_ms=15000)',
      'try:',
      '    for topic in config["topics"]:',
      '        partitions = consumer.partitions_for_topic(topic)',
      '        if not partitions: raise RuntimeError("Missing or inaccessible topic metadata: " + topic)',
      '        print(topic, "partitions", sorted(partitions))',
      'finally:',
      '    consumer.close()',
    ].join('\n') + '\n';
    return { 'CHECK.py': check, 'requirements.txt': 'kafka-python>=2.2,<3\naws-msk-iam-sasl-signer-python>=1,<2\n', 'CLIENT-CONFIG.json': JSON.stringify({ region, topics, consumer_groups: groups, operations: access, role_arn: role, security_protocol: 'SASL_SSL', sasl_mechanism: 'OAUTHBEARER' }, null, 2) + '\n' };
}
