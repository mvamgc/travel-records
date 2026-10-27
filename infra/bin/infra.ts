#!/usr/bin/env node
import { App } from 'aws-cdk-lib';
import { CiStack } from '../lib/ci-stack';
import { ENVIRONMENTS, GITHUB_REPOSITORY, REGION } from '../lib/config';
import { TravelRecordsStack } from '../lib/travel-records-stack';

const app = new App();
const env = { account: process.env.CDK_DEFAULT_ACCOUNT, region: REGION };

for (const config of ENVIRONMENTS) {
  new TravelRecordsStack(app, `TravelRecords-${config.name}`, { env, config });
}

new CiStack(app, 'TravelRecords-ci', {
  env,
  repository: GITHUB_REPOSITORY,
  existingOidcProviderArn: app.node.tryGetContext('githubOidcProviderArn'),
});
