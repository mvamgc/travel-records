# Travel Records infrastructure (AWS CDK)

The CDK app behind [ADR-0005](../docs/adr/0005-toolchain-and-deployment.md). All stacks live in one AWS account, in `us-east-1`.

| Stack | What it holds | Deployed by |
|---|---|---|
| `TravelRecords-dev` | The site bucket, CloudFront, the HTTP API and the Lambda functions | GitHub Actions, on every merge to `main` |
| `TravelRecords-prod` | The same, for production | GitHub Actions, run by hand on `main`, gated by the `prod` environment |
| `TravelRecords-ci` | The GitHub OIDC provider and the roles the workflows assume | You, once, from your machine |

## Commands

Run these in `infra/`, after `npm ci`.

- `npx jest` runs the infrastructure tests. They skip the Rust build, so they take seconds.
- `npx cdk synth --all` synthesizes every stack. It builds the Lambda binaries for arm64 with cargo-lambda and zig, and it needs the PWA built first (`trunk build --release` in `crates/client`).
- `npx cdk diff TravelRecords-dev` and `npx cdk deploy TravelRecords-dev` need AWS credentials.

## First-time setup

Until these steps are done, the deploy workflow and the `cdk diff` job in CI are skipped.

1. **Bootstrap CDK** in the account, with credentials for an administrator:

   ```sh
   npx cdk bootstrap aws://ACCOUNT_ID/us-east-1
   ```

2. **Deploy the CI stack.** It creates the account's GitHub OIDC provider and three roles: `TravelRecordsDeployDev`, `TravelRecordsDeployProd` and `TravelRecordsDiffDev`. Each may only assume the CDK bootstrap roles it needs.

   ```sh
   npx cdk deploy TravelRecords-ci
   ```

   If the account already has a provider for `token.actions.githubusercontent.com`, reuse it:

   ```sh
   npx cdk deploy TravelRecords-ci -c githubOidcProviderArn=arn:aws:iam::ACCOUNT_ID:oidc-provider/token.actions.githubusercontent.com
   ```

3. **Create two GitHub environments** in the repository settings:
   - `dev`, limited to the `main` branch;
   - `prod`, limited to the `main` branch and with required reviewers.

   The deploy roles trust only workflow runs in these environments.

4. **Set three repository variables** (Settings → Secrets and variables → Actions → Variables) to the role ARNs that step 2 printed:
   - `AWS_DEPLOY_ROLE_DEV`
   - `AWS_DEPLOY_ROLE_PROD`
   - `AWS_DIFF_ROLE_DEV`

   These are ARNs, not secrets. No AWS keys are stored in GitHub.

From then on, every merge to `main` deploys dev, pull requests show a `cdk diff` against dev, and running the Deploy workflow by hand on `main` deploys prod. The stacks print their URL as the `Url` output.

## Not here yet

- The DynamoDB table, which waits for the data-model LLD: ADR-0003's ordered-read index must exist when the table is created.
- The media bucket, the Cognito user pool and the other functions of ADR-0001, ADR-0006, ADR-0009 and ADR-0010.
- Prod's own domain and certificate (ADR-0005 decision 5). Until then, prod uses its `*.cloudfront.net` name.
- A Content Security Policy (ADR-0009). Trunk's inline loader script needs a hash or a nonce first.
