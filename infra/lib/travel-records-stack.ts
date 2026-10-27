import { CfnOutput, Stack, StackProps } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { Api } from './api';
import { EnvironmentConfig, SITE_DIR } from './config';
import { Web } from './web';

export interface TravelRecordsStackProps extends StackProps {
  readonly config: EnvironmentConfig;
  /** The built PWA; defaults to `crates/client/dist`. */
  readonly siteDir?: string;
}

/**
 * One environment: `TravelRecords-dev` or `TravelRecords-prod` (ADR-0005 decision 1).
 *
 * The walking skeleton has the API and the web front. The data and auth
 * constructs follow with the data-model LLD and ADR-0009.
 */
export class TravelRecordsStack extends Stack {
  constructor(scope: Construct, id: string, props: TravelRecordsStackProps) {
    super(scope, id, props);

    const api = new Api(this, 'Api', { config: props.config });
    const web = new Web(this, 'Web', { api: api.httpApi, siteDir: props.siteDir ?? SITE_DIR });

    new CfnOutput(this, 'Url', { value: `https://${web.distribution.distributionDomainName}` });
  }
}
