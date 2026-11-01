import { existsSync } from 'node:fs';
import * as path from 'node:path';
import { Fn, RemovalPolicy, Stack } from 'aws-cdk-lib';
import { HttpApi } from 'aws-cdk-lib/aws-apigatewayv2';
import {
  AllowedMethods,
  CachePolicy,
  Distribution,
  Function as CloudFrontFunction,
  FunctionCode,
  FunctionEventType,
  FunctionRuntime,
  HttpVersion,
  OriginRequestPolicy,
  ViewerProtocolPolicy,
} from 'aws-cdk-lib/aws-cloudfront';
import { HttpOrigin, S3BucketOrigin } from 'aws-cdk-lib/aws-cloudfront-origins';
import { BlockPublicAccess, Bucket, BucketEncryption } from 'aws-cdk-lib/aws-s3';
import { BucketDeployment, CacheControl, ISource, Source } from 'aws-cdk-lib/aws-s3-deployment';
import { Construct } from 'constructs';

export interface WebProps {
  readonly api: HttpApi;
  /** The built PWA. */
  readonly siteDir: string;
}

/**
 * Files that name the current build and must never be cached: the shell's
 * entry point, the service worker, the manifest and its icons. Everything
 * else Trunk writes has a content hash in its name.
 */
const UNHASHED_FILES = ['index.html', 'sw.js', 'manifest.webmanifest', 'icons/*'];

/** One CloudFront origin for the PWA and the API (ADR-0005 decision 5). */
export class Web extends Construct {
  readonly distribution: Distribution;

  constructor(scope: Construct, id: string, props: WebProps) {
    super(scope, id);

    const bucket = new Bucket(this, 'Site', {
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      encryption: BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      // Holds build output only, which every deploy uploads again.
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    // Every app route is the single-page app, so a path whose last segment
    // has no file extension gets index.html.
    const spaRouting = new CloudFrontFunction(this, 'SpaRouting', {
      runtime: FunctionRuntime.JS_2_0,
      code: FunctionCode.fromInline(`function handler(event) {
  var request = event.request;
  var last = request.uri.split('/').pop();
  if (last.indexOf('.') === -1) {
    request.uri = '/index.html';
  }
  return request;
}`),
    });

    this.distribution = new Distribution(this, 'Distribution', {
      comment: `Travel Records ${Stack.of(this).stackName}`,
      defaultRootObject: 'index.html',
      httpVersion: HttpVersion.HTTP2_AND_3,
      defaultBehavior: {
        origin: S3BucketOrigin.withOriginAccessControl(bucket),
        viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: CachePolicy.CACHING_OPTIMIZED,
        functionAssociations: [{ function: spaRouting, eventType: FunctionEventType.VIEWER_REQUEST }],
      },
      additionalBehaviors: {
        '/api/*': {
          // apiEndpoint is https://{id}.execute-api.{region}.amazonaws.com
          origin: new HttpOrigin(Fn.select(2, Fn.split('/', props.api.apiEndpoint))),
          viewerProtocolPolicy: ViewerProtocolPolicy.HTTPS_ONLY,
          allowedMethods: AllowedMethods.ALLOW_ALL,
          cachePolicy: CachePolicy.CACHING_DISABLED,
          // Everything but Host, which API Gateway needs to be its own name.
          originRequestPolicy: OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
        },
      },
    });

    const site = siteSource(this, props.siteDir);
    // Hashed files never change, so browsers and CloudFront keep them for a year.
    // Old ones stay (no pruning), so a page still running the previous build can load them.
    const assets = new BucketDeployment(this, 'DeployAssets', {
      sources: [site],
      destinationBucket: bucket,
      exclude: UNHASHED_FILES,
      cacheControl: [CacheControl.fromString('public, max-age=31536000, immutable')],
      prune: false,
    });
    // Uploaded after the files they refer to, never cached, and invalidated on every deploy.
    const entry = new BucketDeployment(this, 'DeployEntryFiles', {
      sources: [site],
      destinationBucket: bucket,
      exclude: ['*'],
      include: UNHASHED_FILES,
      cacheControl: [CacheControl.noCache()],
      prune: false,
      distribution: this.distribution,
      distributionPaths: UNHASHED_FILES.map((file) => `/${file}`),
    });
    entry.node.addDependency(assets);
  }
}

/**
 * The built PWA. Synthesizing another stack, such as the CI stack, doesn't
 * need a client build, so a placeholder stands in when this stack isn't
 * being deployed.
 */
function siteSource(scope: Construct, siteDir: string): ISource {
  if (existsSync(path.join(siteDir, 'index.html'))) {
    return Source.asset(siteDir);
  }
  if (Stack.of(scope).bundlingRequired) {
    throw new Error(`No PWA build in ${siteDir}: run "trunk build --release" in crates/client first.`);
  }
  return Source.data('index.html', '<!-- not built -->');
}
