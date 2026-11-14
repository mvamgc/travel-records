import * as path from 'node:path';
import { RetentionDays } from 'aws-cdk-lib/aws-logs';

/** Every stack lives in us-east-1, where CloudFront certificates must come from anyway (ADR-0005). */
export const REGION = 'us-east-1';

/**
 * The OIDC `sub` claim prefix of the GitHub repository whose workflows may assume the CI roles.
 *
 * GitHub repositories created on or after 15 July 2026 put the owner's and the repository's
 * numeric IDs in the claim (`repo:owner@OWNER_ID/name@REPO_ID`), so a trust policy keeps working
 * after a rename and never matches a new repository that takes over the name. To read it:
 * `gh api repos/mvamgc/travel-records/actions/oidc/customization/sub --jq .sub_claim_prefix`.
 */
export const GITHUB_SUBJECT_PREFIX = 'repo:mvamgc@3931780/travel-records@1404578494';

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
