#!/usr/bin/env node
import { App } from 'aws-cdk-lib';
import { CiStack } from '../lib/ci-stack';
import { EnvironmentConfig, ENVIRONMENTS, GITHUB_SUBJECT_PREFIX, REGION } from '../lib/config';
import { TravelRecordsStack } from '../lib/travel-records-stack';

const app = new App();
const env = { account: process.env.CDK_DEFAULT_ACCOUNT, region: REGION };

for (const base of ENVIRONMENTS) {
  const config: EnvironmentConfig = { ...base, domain: domainFromContext(app, base.name) };
  new TravelRecordsStack(app, `TravelRecords-${config.name}`, { env, config });
}

function domainFromContext(app: App, stage: string) {
  // An unset GitHub variable arrives as '', so treat it as absent.
  const name = app.node.tryGetContext(`${stage}DomainName`) || undefined;
  const hostedZoneId = app.node.tryGetContext(`${stage}HostedZoneId`) || undefined;
  if (!name) return undefined;
  if (!hostedZoneId) throw new Error(`${stage}DomainName needs ${stage}HostedZoneId`);
  return { name, hostedZoneId };
}

new CiStack(app, 'TravelRecords-ci', {
  env,
  subjectPrefix: GITHUB_SUBJECT_PREFIX,
  existingOidcProviderArn: app.node.tryGetContext('githubOidcProviderArn'),
});
