import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { CiStack } from '../lib/ci-stack';

const PREFIX = 'repo:owner@1/repo@2';

function synth(existingOidcProviderArn?: string): Template {
  const app = new App();
  const stack = new CiStack(app, 'TravelRecords-ci', {
    env: { account: '123456789012', region: 'us-east-1' },
    subjectPrefix: PREFIX,
    existingOidcProviderArn,
  });
  return Template.fromStack(stack);
}

function trustedSubject(template: Template, roleName: string): string {
  const roles = template.findResources('AWS::IAM::Role', { Properties: { RoleName: roleName } });
  const [role] = Object.values(roles);
  return role.Properties.AssumeRolePolicyDocument.Statement[0].Condition.StringEquals[
    'token.actions.githubusercontent.com:sub'
  ];
}

test('each role trusts exactly one kind of workflow run', () => {
  const template = synth();
  expect(trustedSubject(template, 'TravelRecordsDeployDev')).toBe(`${PREFIX}:environment:dev`);
  expect(trustedSubject(template, 'TravelRecordsDeployProd')).toBe(`${PREFIX}:environment:prod`);
  expect(trustedSubject(template, 'TravelRecordsDiffDev')).toBe(`${PREFIX}:pull_request`);
});

test('the diff role may only assume the lookup role', () => {
  const template = synth();
  template.hasResourceProperties('AWS::IAM::Policy', {
    PolicyDocument: {
      Statement: [
        Match.objectLike({
          Action: 'sts:AssumeRole',
          Condition: { StringEquals: { 'iam:ResourceTag/aws-cdk:bootstrap-role': ['lookup'] } },
        }),
      ],
    },
    Roles: [{ Ref: Match.stringLikeRegexp('^DiffDev') }],
  });
});

test('the OIDC provider is created unless one already exists', () => {
  synth().resourceCountIs('AWS::IAM::OIDCProvider', 1);
  synth('arn:aws:iam::123456789012:oidc-provider/token.actions.githubusercontent.com').resourceCountIs(
    'AWS::IAM::OIDCProvider',
    0,
  );
});
