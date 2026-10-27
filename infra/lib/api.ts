import * as path from 'node:path';
import { Duration, RemovalPolicy } from 'aws-cdk-lib';
import { HttpApi, HttpMethod } from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import { Architecture, LoggingFormat } from 'aws-cdk-lib/aws-lambda';
import { LogGroup } from 'aws-cdk-lib/aws-logs';
import { RustFunction } from 'cargo-lambda-cdk';
import { Construct } from 'constructs';
import { EnvironmentConfig, REPO_ROOT } from './config';

export interface ApiProps {
  readonly config: EnvironmentConfig;
}

/** The HTTP API and its functions (ADR-0005 decision 3). Routes live under `/api/…`. */
export class Api extends Construct {
  readonly httpApi: HttpApi;

  constructor(scope: Construct, id: string, props: ApiProps) {
    super(scope, id);

    const sync = serverFunction(this, 'Sync', 'sync', props.config);

    this.httpApi = new HttpApi(this, 'HttpApi', {
      description: 'Travel Records API, reached through CloudFront under /api',
    });
    this.httpApi.addRoutes({
      path: '/api/health',
      methods: [HttpMethod.GET],
      integration: new HttpLambdaIntegration('SyncIntegration', sync),
    });
  }
}

/** One binary of the `server` crate, built for arm64 by cargo-lambda during synth. */
function serverFunction(
  scope: Construct,
  id: string,
  binaryName: string,
  config: EnvironmentConfig,
): RustFunction {
  return new RustFunction(scope, id, {
    manifestPath: path.join(REPO_ROOT, 'crates/server/Cargo.toml'),
    binaryName,
    architecture: Architecture.ARM_64,
    memorySize: 256,
    timeout: Duration.seconds(10),
    loggingFormat: LoggingFormat.JSON,
    logGroup: new LogGroup(scope, `${id}Logs`, {
      retention: config.logRetention,
      removalPolicy: RemovalPolicy.DESTROY,
    }),
  });
}
