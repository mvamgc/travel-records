import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { ENVIRONMENTS } from '../lib/config';
import { TravelRecordsStack } from '../lib/travel-records-stack';

// Managed policy IDs (CloudFront developer guide).
const CACHING_DISABLED = '4135ea2d-6df8-44a3-9df3-4b5a84be39ad';
const ALL_VIEWER_EXCEPT_HOST_HEADER = 'b689b0a8-53d0-40ab-baf2-68738e2966ac';

function synth(): Template {
  // No Rust build in unit tests: cdk synth in CI covers that.
  const app = new App({ context: { 'aws:cdk:bundling-stacks': [] } });
  const siteDir = mkdtempSync(path.join(tmpdir(), 'site-'));
  writeFileSync(path.join(siteDir, 'index.html'), '<!DOCTYPE html>');
  const stack = new TravelRecordsStack(app, 'TravelRecords-test', {
    env: { account: '123456789012', region: 'us-east-1' },
    config: ENVIRONMENTS[0],
    siteDir,
  });
  return Template.fromStack(stack);
}

const template = synth();

test('functions run Rust on arm64 with JSON logs', () => {
  template.hasResourceProperties('AWS::Lambda::Function', {
    Runtime: 'provided.al2023',
    Handler: 'bootstrap',
    Architectures: ['arm64'],
    LoggingConfig: Match.objectLike({ LogFormat: 'JSON' }),
  });
});

test('the API routes the health check to sync', () => {
  template.hasResourceProperties('AWS::ApiGatewayV2::Route', { RouteKey: 'GET /api/health' });
});

test('CloudFront forwards /api/* uncached, with every method and header but Host', () => {
  template.hasResourceProperties('AWS::CloudFront::Distribution', {
    DistributionConfig: Match.objectLike({
      CacheBehaviors: [
        Match.objectLike({
          PathPattern: '/api/*',
          AllowedMethods: ['GET', 'HEAD', 'OPTIONS', 'PUT', 'PATCH', 'POST', 'DELETE'],
          CachePolicyId: CACHING_DISABLED,
          OriginRequestPolicyId: ALL_VIEWER_EXCEPT_HOST_HEADER,
        }),
      ],
    }),
  });
});

test('app routes are rewritten to the shell, files and the API are not', () => {
  const functions = template.findResources('AWS::CloudFront::Function');
  const code: string = Object.values(functions)[0].Properties.FunctionCode;
  const handler = new Function(`${code}; return handler;`)() as (event: unknown) => { uri: string };
  const route = (uri: string) => handler({ request: { uri } }).uri;
  expect(route('/')).toBe('/index.html');
  expect(route('/albums/123')).toBe('/index.html');
  expect(route('/client-abc.js')).toBe('/client-abc.js');
  expect(route('/icons/icon-192.png')).toBe('/icons/icon-192.png');
});

test('the site bucket is private and only reachable through CloudFront', () => {
  template.hasResourceProperties('AWS::S3::Bucket', {
    PublicAccessBlockConfiguration: {
      BlockPublicAcls: true,
      BlockPublicPolicy: true,
      IgnorePublicAcls: true,
      RestrictPublicBuckets: true,
    },
  });
  template.resourceCountIs('AWS::CloudFront::OriginAccessControl', 1);
});

test('unhashed shell files are uploaded uncached, after the hashed assets', () => {
  const deployments = template.findResources('Custom::CDKBucketDeployment');
  const entry = Object.entries(deployments).find(([id]) => id.includes('DeployEntryFiles'));
  expect(entry).toBeDefined();
  const [, resource] = entry!;
  expect(resource.Properties.SystemMetadata).toEqual({ 'cache-control': 'no-cache' });
  expect(resource.DependsOn.some((id: string) => id.includes('DeployAssets'))).toBe(true);
});
