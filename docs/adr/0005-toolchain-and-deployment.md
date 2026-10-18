# ADR-0005: Build and deployment toolchain — CDK, cargo-lambda, axum, CloudFront

- **Status:** Accepted
- **Date:** 2026-10-14
- **Resolves:** HLD §5 open decision on infrastructure-as-code and the Rust Lambda toolchain; HLD §11 ADR-0005
- **Changes requirements:** none

## Context

The earlier decisions fix what has to be deployed:

- an API Gateway HTTP API with a Cognito JWT authorizer (HLD §3, §5);
- HTTP functions `sync`, `media`, `sharing` and `public-viewer`, and background jobs `media-assembler` (ADR-0001), `access-loss` and `purge` (ADR-0003), and `public-media` ([ADR-0006](0006-public-media-location.md));
- one DynamoDB table whose index for ordered, strongly consistent reads must exist when the table is created (ADR-0003);
- an S3 media bucket with lifecycle rules for `staging/` and incomplete multipart uploads (ADR-0001);
- a Cognito user pool (ADR-0002);
- hosting for the PWA itself, which the HLD didn't cover yet.

More constraints:

- **Application code is Rust on both sides:** the client is Leptos compiled to WASM, and the server is Lambdas. Types, the sync and upload protocols, and the HLC code (ADR-0004) should be written once.
- **Clients sit on slow, high-latency links**, so every avoidable round trip counts.
- **A PWA needs HTTPS.** Its installation and all its local data, including guest content (ADR-0002), are tied to its exact origin.
- **This is a POC:** scale-to-zero, low cost, and a short path from code to a running stack.

Decision drivers, in priority order:

1. Infrastructure is code, reviewed in pull requests, and reproducible per environment.
2. Rust code is shared between client and server.
3. Fast local iteration without emulators.
4. Each function gets only the permissions it needs.
5. As few round trips as possible for clients on slow links.

## Decision

### 1. Infrastructure: AWS CDK v2 in TypeScript

The CDK app lives in `infra/`.

- **One stack per environment:** `TravelRecords-dev` and `TravelRecords-prod`, in one AWS account, in `us-east-1`. CloudFront certificates must come from ACM in `us-east-1` anyway.
  - Inside each stack, constructs group the resources: data (table, media bucket), auth (user pool), API (HTTP API, functions, jobs) and web (site bucket, distribution).
  - One stack per environment avoids cross-stack exports, which block later changes, and keeps the environment as the unit of deployment.
- **Stateful resources** (table, media bucket, user pool) are retained when the prod stack is deleted, and destroyed with the dev stack. The prod table has deletion protection and point-in-time recovery.
- **Lambdas** are defined with `RustFunction` from the community package `cargo-lambda-cdk`, which runs cargo-lambda during `cdk synth`. The fallback, if it ever gets in the way, is `lambda.Code.fromAsset` on the output of `cargo lambda build`.
- **Infrastructure tests** use `aws-cdk-lib/assertions`. They check, for example, that the ordered-read index exists, that the lifecycle rules are in place, and what permissions each function's role has.

### 2. Repository layout

```
Cargo.toml          workspace
crates/shared/      types, sync and upload protocol, HLC — builds for wasm32 and native
crates/client/      Leptos CSR PWA, built with Trunk
crates/server/      library: axum routers per concern, DynamoDB and S3 access, auth
                    binaries: sync, media, sharing, public-viewer               (HTTP)
                              media-assembler, access-loss, purge, public-media (jobs)
                              dev-server                                        (local)
infra/              CDK app (TypeScript)
```

- A single `server` crate with several binaries compiles its dependencies once, and each binary links only the code it uses.
- All Lambdas run on **arm64** (Graviton), which is about 20% cheaper per GB-second than x86. cargo-lambda cross-compiles for it.

### 3. Lambda functions

- **HTTP functions** are axum routers served through `lambda_http`, one function per concern: `sync`, `media`, `sharing` and `public-viewer`.
  - Each has its own IAM role, limited to the tables, buckets and actions it uses.
  - Routes live under `/api/…`, so CloudFront can forward paths unchanged (decision 5).
- **Jobs** use `lambda_runtime` with typed events from `aws_lambda_events`:
  - `media-assembler` is invoked asynchronously by `media`, with retries and an on-failure destination;
  - `access-loss` is invoked asynchronously by `sharing`;
  - `public-media` is invoked asynchronously by `sharing` and `public-viewer`;
  - `purge` runs on an EventBridge schedule.
- **Logging:** every function writes structured JSON logs through `tracing`, with log retention set per environment.

### 4. Local development

- The `dev-server` binary mounts all routers under `/api` on localhost. `trunk serve` proxies `/api` to it, so local development is same-origin too.
- `dev-server` talks to the developer's dev stack in AWS: table, bucket and user pool.
- In Lambda, API Gateway has already checked the token, so routers read the user from the authorizer's claims. In `dev-server`, the same auth extractor checks the token itself against the user pool's signing keys.
- Integration tests run against DynamoDB Local in Docker. They cover the transaction and condition logic of ADR-0003 and ADR-0004.

### 5. Hosting: one origin through CloudFront

Each environment has one CloudFront distribution:

- **`/*`** serves the SPA from a private S3 bucket, through an origin access control. `index.html` and the service worker are never cached; hashed assets are cached long-term.
- **`/api/*`** goes to the API Gateway HTTP API, with caching disabled, all methods allowed (including `PATCH` and `HEAD`), and the `Authorization` and upload headers forwarded.

**Why one origin:**

- **No CORS at all, so no preflight requests.** With separate domains, every `PATCH` carrying `Upload-Offset` would first need an `OPTIONS` round trip. Browsers cache preflight answers per URL, so each new `/uploads/{id}` would cost another one.
- **TLS ends at an edge location near the traveller**, which shortens handshakes on high-latency links.

**Domains:**

- **Prod uses your own domain** from the first real user, through a Route 53 hosted zone and an ACM certificate. Installed apps and local data are tied to the origin, so moving users later would leave both behind on the old name.
- **Dev uses its default `*.cloudfront.net` name.**

Media downloads keep using presigned S3 URLs (HLD §4, §7). They are simple `GET` requests and trigger no preflight.

### 6. CI/CD: GitHub Actions with OIDC

| When | What runs |
|---|---|
| Every pull request | `cargo fmt --check`, `clippy`, tests (including DynamoDB Local), the client's WASM build, `cdk synth` with the infrastructure tests, and `cdk diff` against dev. |
| Merge to `main` | Deploy the dev stack. |
| Manual trigger | Deploy the prod stack, gated by a protected GitHub `prod` environment. |

AWS access goes through OIDC, so no AWS keys are stored in GitHub. There is one deploy role per environment, and the prod role can be assumed only from the `prod` environment.

## Considered options

1. **AWS SAM.** One YAML template with short syntax for serverless resources, and no second language. Rejected in favour of CDK, because CDK gives:
   - a real language for the stack, with loops over functions and shared settings;
   - typed constructs and infrastructure unit tests;
   - easier handling of CloudFront with origin access control and of per-environment configuration, which get verbose in YAML.
2. **Terraform / OpenTofu.** Mature and not tied to AWS. Rejected: it needs a state backend to run, and Lambda packaging becomes a separate step.
3. **One Lambda for the whole API.** The simplest infrastructure, and the function stays warm more often at low traffic. Rejected: one role would need every permission.
4. **One function per route, on `lambda_runtime`.** Rejected: many more resources to define, and no local server without an emulator.
5. **Running axum through the Lambda Web Adapter.** Rejected: it adds an extension layer, while `lambda_http` serves axum routers directly.
6. **Separate domains for the SPA and the API, with CORS.** Rejected: preflights on custom headers, cached per URL, cost an extra round trip on every new upload.
7. **Separate AWS accounts per environment.** Stronger isolation of data and permissions. Deferred: more setup than an early POC needs.
8. **Deploying manually from a laptop.** Rejected: nothing would guard `main` or keep environments reproducible.

## Consequences

- **Good:**
  - typed, tested infrastructure;
  - Rust crates shared between client and server;
  - the same router code runs in Lambda and locally;
  - a narrow IAM role for each function;
  - no CORS preflights, and TLS ends near the user;
  - reproducible environments, and CI with no stored keys.
- **Bad:**
  - two languages and toolchains: Rust, and Node/TypeScript for `infra/` only;
  - CloudFormation deploys take minutes;
  - `cargo-lambda-cdk` is community-maintained;
  - CloudFront adds a hop with its own timeouts and header rules, which must be checked for uploads;
  - one account means dev and prod share account-level quotas and blast radius.
- **Follow-ups:**
  - the first implementation PR: workspace scaffolding, the CDK app and the CI workflows;
  - registering the prod domain and its hosted zone;
  - the sign-in UI decision (ADR-0002, open item), which sets the Cognito hosted domain and callback URLs on the CloudFront domain.

## Validation spike

1. `RustFunction` builds arm64 binaries from the workspace during `cdk synth` on GitHub-hosted runners.
2. Through CloudFront to API Gateway:
   - `Authorization`, `Upload-Offset`, `Upload-Length`, `Repr-Digest` and `Content-Digest` reach the Lambda;
   - `PATCH` and `HEAD` pass through;
   - ADR-0001's slow-client test of a 4 MiB chunk survives CloudFront's origin timeouts.
3. DynamoDB Local supports what ADR-0003 and ADR-0004 rely on: transactions, conditions on nested map paths, and returning the item when a condition fails. If it doesn't, those tests run against the dev stack instead.
4. `dev-server` accepts exactly the tokens the API Gateway authorizer accepts.

## References

- [HLD](../hld.md) §1, §5, §10; [ADR-0001](0001-resumable-media-upload.md), [ADR-0002](0002-guest-identity.md), [ADR-0003](0003-sync-scopes.md), [ADR-0004](0004-conflict-versioning.md).
- AWS CDK v2 Developer Guide; `cargo-lambda` and `cargo-lambda-cdk`; `lambda_http` / `lambda_runtime` (AWS Lambda Rust runtime).
- GitHub Docs, *Configuring OpenID Connect in Amazon Web Services*.
