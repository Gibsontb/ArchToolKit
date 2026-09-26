/**
 * CloudFormation resource properties against the registry schemas in
 * web/data/editor/cloudformation/ (read synchronously in Node).
 */

import { describe, it } from 'node:test';
import { expect } from '../testing/expect.ts';
import { readYaml } from '../core/yaml-read.ts';
import type { Finding } from '../core/findings.ts';
import { parsePath, type Json } from './doc.ts';
import { awsCloudFormation } from './profiles/aws.ts';
import { cfnTypes, cfnTypeSchema, loadCfnType } from './cloudformation-schema.ts';

const yaml = (text: string): Json => readYaml(text).documents[0] as Json;
const run = (doc: Json): Finding[] => awsCloudFormation.validate?.(doc) ?? [];
const errors = (fs: Finding[]) => fs.filter((f) => f.severity === 'error');
const show = (fs: Finding[]) => fs.map((f) => `${f.code} ${f.path}: ${f.message}`);

describe('cloudformation schema data', () => {
  it('lists the registry types and reads a schema without awaiting', () => {
    expect(cfnTypes().length > 1000).toBe(true);
    const bucket = cfnTypeSchema('AWS::S3::Bucket');
    expect(bucket?.p.BucketName).toBe('s');
    expect(bucket?.ro?.includes('Arn')).toBe(true);
  });

  it('loadCfnType resolves for known, loaded and unknown types', async () => {
    await loadCfnType('AWS::S3::Bucket');
    await loadCfnType('AWS::Nope::Nothing');
  });
});

describe('cloudformation resource properties', () => {
  it('an S3 bucket with an unknown property gets a did-you-mean', () => {
    const f = run(yaml(`
Resources:
  Logs:
    Type: AWS::S3::Bucket
    Properties:
      BuketName: logs
      VersioningConfiguration:
        Status: Enabled
`));
    const unknown = f.find((x) => x.code === 'cfn.property.unknown');
    expect(unknown?.path).toBe('Resources.Logs.Properties.BuketName');
    expect(unknown?.severity).toBe('error');
    expect(unknown?.message.includes('Did you mean BucketName?')).toBe(true);
  });

  it('an EC2 instance with a bad enum, a wrong type and a read-only property', () => {
    const f = run(yaml(`
Resources:
  Web:
    Type: AWS::EC2::Instance
    Properties:
      ImageId: ami-12345678
      InstanceType: t3.micro
      Affinity: hosts
      Monitoring: sometimes
      SecurityGroupIds: sg-123
      MetadataOptions:
        HttpTokens: mandatory
      InstanceId: i-123
`));
    const at = (code: string) => f.filter((x) => x.code === code).map((x) => x.path);
    expect(at('cfn.property.enum').sort()).toEqual(['Resources.Web.Properties.Affinity', 'Resources.Web.Properties.MetadataOptions.HttpTokens']);
    expect(f.find((x) => x.path === 'Resources.Web.Properties.Affinity')?.message.includes('Did you mean host?')).toBe(true);
    expect(at('cfn.property.type').sort()).toEqual(['Resources.Web.Properties.Monitoring', 'Resources.Web.Properties.SecurityGroupIds']);
    expect(at('cfn.property.read-only')).toEqual(['Resources.Web.Properties.InstanceId']);
    expect(at('cfn.property.required')).toEqual([]);
  });

  it('a missing required property, in a nested definition and in a list of objects', () => {
    const f = run(yaml(`
Resources:
  Role:
    Type: AWS::IAM::Role
    Properties:
      Policies:
        - PolicyName: read
      Tags:
        - Key: owner
`));
    const req = f.filter((x) => x.code === 'cfn.property.required').map((x) => `${x.path} ${x.message}`);
    expect(req.some((m) => m.startsWith('Resources.Role.Properties ') && m.includes('AssumeRolePolicyDocument'))).toBe(true);
    expect(req.some((m) => m.startsWith('Resources.Role.Properties.Policies[0] ') && m.includes('PolicyDocument'))).toBe(true);
    expect(req.some((m) => m.startsWith('Resources.Role.Properties.Tags[0] ') && m.includes('Value'))).toBe(true);
  });

  it('a correct template has no errors', () => {
    const f = run(yaml(`
AWSTemplateFormatVersion: '2010-09-09'
Parameters:
  Ami:
    Type: AWS::EC2::Image::Id
Resources:
  Logs:
    Type: AWS::S3::Bucket
    DeletionPolicy: Retain
    Properties:
      VersioningConfiguration:
        Status: Enabled
      BucketEncryption:
        ServerSideEncryptionConfiguration:
          - ServerSideEncryptionByDefault:
              SSEAlgorithm: aws:kms
      PublicAccessBlockConfiguration:
        BlockPublicAcls: true
        BlockPublicPolicy: 'true'
      Tags:
        - Key: owner
          Value: platform
  Web:
    Type: AWS::EC2::Instance
    Properties:
      ImageId: !Ref Ami
      InstanceType: t3.micro
      Monitoring: true
      MetadataOptions:
        HttpTokens: required
        HttpPutResponseHopLimit: '2'
      SecurityGroupIds: [sg-0123]
  Topic:
    Type: AWS::SNS::Topic
    Properties:
      TopicName: alerts
      Subscription:
        - Endpoint: ops@example.com
          Protocol: email
`));
    expect(show(errors(f))).toEqual([]);
  });

  it('never judges intrinsic functions or dynamic references', () => {
    const f = run(yaml(`
Parameters:
  Tokens:
    Type: String
  Env:
    Type: String
Conditions:
  IsProd: !Equals [!Ref Env, prod]
Resources:
  Web:
    Type: AWS::EC2::Instance
    Properties:
      ImageId: '{{resolve:ssm:/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64}}'
      Affinity: !If [IsProd, host, !Ref 'AWS::NoValue']
      Monitoring: !Equals [!Ref Env, prod]
      SecurityGroupIds: !Split [',', !Sub '\${Tokens}']
      MetadataOptions:
        HttpTokens: !Ref Tokens
      Tags:
        - !If [IsProd, { Key: env, Value: prod }, !Ref 'AWS::NoValue']
        - Key: name
          Value: !Sub '\${AWS::StackName}-web'
  Logs:
    Type: AWS::S3::Bucket
    Properties: !If [IsProd, { BucketName: prod-logs }, {}]
`));
    expect(show(f.filter((x) => x.code.startsWith('cfn.property')))).toEqual([]);
  });

  it('an unknown type is an error with a did-you-mean; Custom:: and SAM types are information', () => {
    const f = run(yaml(`
Transform: AWS::Serverless-2016-10-31
Resources:
  Bucket:
    Type: AWS::S3::Buckett
  Hook:
    Type: Custom::Seed
    Properties:
      Anything: goes
  Fn:
    Type: AWS::Serverless::Function
    Properties:
      Handler: index.handler
`));
    const unknown = f.find((x) => x.code === 'cfn.resource.type-unknown');
    expect(unknown?.path).toBe('Resources.Bucket.Type');
    expect(unknown?.message.includes('Did you mean AWS::S3::Bucket?')).toBe(true);
    expect(f.find((x) => x.code === 'cfn.resource.custom')?.severity).toBe('info');
    expect(f.find((x) => x.code === 'cfn.resource.sam')?.severity).toBe('info');
    expect(errors(f).map((x) => x.code)).toEqual(['cfn.resource.type-unknown']);
  });
});

describe('cloudformation choices', () => {
  const doc = yaml(`
Resources:
  Web:
    Type: AWS::EC2::Instance
    Properties:
      Affinity: host
      MetadataOptions:
        HttpTokens: required
  Logs:
    Type: AWS::S3::Bucket
    Properties:
      AccessControl: Private
      BucketEncryption:
        ServerSideEncryptionConfiguration:
          - ServerSideEncryptionByDefault:
              SSEAlgorithm: aws:kms
`);
  const c = (path: string) => awsCloudFormation.choices?.(parsePath(path), doc);

  it('offer a property enum, nested and through lists', () => {
    expect(c('Resources.Web.Properties.Affinity')).toEqual(['default', 'host']);
    expect(c('Resources.Web.Properties.MetadataOptions.HttpTokens')?.includes('required')).toBe(true);
    expect(c('Resources.Logs.Properties.AccessControl')?.includes('PublicRead')).toBe(true);
    expect(c('Resources.Logs.Properties.BucketEncryption.ServerSideEncryptionConfiguration[0].ServerSideEncryptionByDefault.SSEAlgorithm')?.includes('aws:kms')).toBe(true);
    expect(c('Resources.Logs.Properties.BucketName')).toBe(undefined);
  });

  it('offer the resource types of the same service', () => {
    const types = c('Resources.Logs.Type');
    expect(types?.includes('AWS::S3::Bucket')).toBe(true);
    expect(types?.includes('AWS::S3::BucketPolicy')).toBe(true);
    expect(types?.some((t) => !t.startsWith('AWS::S3::'))).toBe(false);
  });
});

describe('cloudformation prepare', () => {
  it('loads every type the template names', async () => {
    await awsCloudFormation.prepare?.(yaml('Resources:\n  A:\n    Type: AWS::SQS::Queue\n  B:\n    Type: Custom::X\n'));
    expect(cfnTypeSchema('AWS::SQS::Queue') !== undefined).toBe(true);
  });
});
