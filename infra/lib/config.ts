import * as path from 'node:path';
import { RetentionDays } from 'aws-cdk-lib/aws-logs';

/** Every stack lives in us-east-1, where CloudFront certificates must come from anyway (ADR-0005). */
export const REGION = 'us-east-1';

/** The GitHub repository whose workflows may assume the CI roles. */
export const GITHUB_REPOSITORY = 'mvamgc/travel-records';

export const REPO_ROOT = path.resolve(__dirname, '../..');

/** Where `trunk build --release` puts the PWA. */
export const SITE_DIR = path.join(REPO_ROOT, 'crates/client/dist');

/** Settings that differ between dev and prod (ADR-0005 decision 1). */
export interface EnvironmentConfig {
  readonly name: 'dev' | 'prod';
  readonly logRetention: RetentionDays;
}

export const ENVIRONMENTS: readonly EnvironmentConfig[] = [
  { name: 'dev', logRetention: RetentionDays.TWO_WEEKS },
  { name: 'prod', logRetention: RetentionDays.THREE_MONTHS },
];
