import { CfnOutput, Duration, Stack, StackProps } from 'aws-cdk-lib';
import { IOidcProvider, OidcProviderNative, PolicyStatement, Role, WebIdentityPrincipal } from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';

const GITHUB_OIDC_URL = 'https://token.actions.githubusercontent.com';
const GITHUB_OIDC_HOST = 'token.actions.githubusercontent.com';

export interface CiStackProps extends StackProps {
  /** `owner/name` of the GitHub repository. */
  readonly repository: string;
  /** The account's GitHub OIDC provider, if one exists already; otherwise this stack creates it. */
  readonly existingOidcProviderArn?: string;
}

/**
 * Roles that GitHub Actions assume through OIDC, so no AWS keys are stored in
 * GitHub (ADR-0005 decision 6). Deployed once by hand: `cdk deploy TravelRecords-ci`.
 *
 * Each role may only assume the CDK bootstrap roles it needs.
 */
export class CiStack extends Stack {
  constructor(scope: Construct, id: string, props: CiStackProps) {
    super(scope, id, props);

    const provider: IOidcProvider = props.existingOidcProviderArn
      ? OidcProviderNative.fromOidcProviderArn(this, 'GitHub', props.existingOidcProviderArn)
      : new OidcProviderNative(this, 'GitHub', { url: GITHUB_OIDC_URL, clientIds: ['sts.amazonaws.com'] });

    const githubRole = (name: string, subject: string, bootstrapRoles: string[]) => {
      const role = new Role(this, name, {
        roleName: `TravelRecords${name}`,
        maxSessionDuration: Duration.hours(1),
        assumedBy: new WebIdentityPrincipal(provider.oidcProviderArn, {
          StringEquals: {
            [`${GITHUB_OIDC_HOST}:aud`]: 'sts.amazonaws.com',
            [`${GITHUB_OIDC_HOST}:sub`]: subject,
          },
        }),
      });
      role.addToPolicy(
        new PolicyStatement({
          actions: ['sts:AssumeRole'],
          resources: [`arn:${this.partition}:iam::${this.account}:role/cdk-*`],
          conditions: { StringEquals: { 'iam:ResourceTag/aws-cdk:bootstrap-role': bootstrapRoles } },
        }),
      );
      new CfnOutput(this, `${name}RoleArn`, { value: role.roleArn });
    };

    const deployRoles = ['deploy', 'file-publishing', 'lookup'];
    // Merges to main deploy dev from the GitHub `dev` environment.
    githubRole('DeployDev', `repo:${props.repository}:environment:dev`, deployRoles);
    // Only the protected GitHub `prod` environment can deploy prod.
    githubRole('DeployProd', `repo:${props.repository}:environment:prod`, deployRoles);
    // Pull requests run `cdk diff` against dev, which only reads.
    githubRole('DiffDev', `repo:${props.repository}:pull_request`, ['lookup']);
  }
}
