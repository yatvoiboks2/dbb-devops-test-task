import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as iam from 'aws-cdk-lib/aws-iam';

export interface GithubOidcStackProps extends cdk.StackProps {
  /** GitHub repo slug in the form `owner/repo`. */
  readonly githubRepo: string;
  /** Optional — restrict trust further, e.g. `ref:refs/heads/main`. Defaults to any branch. */
  readonly githubSubjectClaim?: string;
  /**
   * ARN of an existing `token.actions.githubusercontent.com` OIDC provider
   * (one per account). If omitted, a new provider is created.
   */
  readonly existingOidcProviderArn?: string;
  readonly roleName?: string;
  readonly ecrRepositoryArn: string;
  readonly versionsBucketName: string;
  readonly ebApplicationName: string;
}

export class GithubOidcStack extends cdk.Stack {
  public readonly roleArn: string;

  constructor(scope: Construct, id: string, props: GithubOidcStackProps) {
    super(scope, id, props);

    const provider: iam.IOpenIdConnectProvider = props.existingOidcProviderArn
      ? iam.OpenIdConnectProvider.fromOpenIdConnectProviderArn(
          this,
          'GithubProvider',
          props.existingOidcProviderArn,
        )
      : new iam.OpenIdConnectProvider(this, 'GithubProvider', {
          url: 'https://token.actions.githubusercontent.com',
          clientIds: ['sts.amazonaws.com'],
        });

    const subject = props.githubSubjectClaim ?? '*';
    const role = new iam.Role(this, 'DeployRole', {
      roleName: props.roleName,
      description: `GitHub Actions deploy role for ${props.githubRepo}`,
      maxSessionDuration: cdk.Duration.hours(1),
      assumedBy: new iam.FederatedPrincipal(
        provider.openIdConnectProviderArn,
        {
          StringEquals: {
            'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
          },
          StringLike: {
            'token.actions.githubusercontent.com:sub': `repo:${props.githubRepo}:${subject}`,
          },
        },
        'sts:AssumeRoleWithWebIdentity',
      ),
    });

    role.addToPolicy(
      new iam.PolicyStatement({
        sid: 'EcrAuth',
        actions: ['ecr:GetAuthorizationToken'],
        resources: ['*'],
      }),
    );
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: 'EcrPushPull',
        actions: [
          'ecr:BatchCheckLayerAvailability',
          'ecr:BatchGetImage',
          'ecr:CompleteLayerUpload',
          'ecr:DescribeImages',
          'ecr:DescribeRepositories',
          'ecr:GetDownloadUrlForLayer',
          'ecr:InitiateLayerUpload',
          'ecr:PutImage',
          'ecr:UploadLayerPart',
        ],
        resources: [props.ecrRepositoryArn],
      }),
    );
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: 'UploadAppVersions',
        actions: ['s3:PutObject', 's3:GetObject', 's3:ListBucket'],
        resources: [
          `arn:aws:s3:::${props.versionsBucketName}`,
          `arn:aws:s3:::${props.versionsBucketName}/*`,
        ],
      }),
    );
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: 'DeployToBeanstalk',
        actions: [
          'elasticbeanstalk:CreateApplicationVersion',
          'elasticbeanstalk:UpdateEnvironment',
          'elasticbeanstalk:DescribeEnvironments',
          'elasticbeanstalk:DescribeEvents',
          'elasticbeanstalk:DescribeApplicationVersions',
        ],
        resources: [
          `arn:aws:elasticbeanstalk:${this.region}:${this.account}:application/${props.ebApplicationName}`,
          `arn:aws:elasticbeanstalk:${this.region}:${this.account}:applicationversion/${props.ebApplicationName}/*`,
          `arn:aws:elasticbeanstalk:${this.region}:${this.account}:environment/${props.ebApplicationName}/*`,
        ],
      }),
    );

    this.roleArn = role.roleArn;

    new cdk.CfnOutput(this, 'DeployRoleArn', {
      value: role.roleArn,
      description: 'Set as GitHub repo variable AWS_DEPLOY_ROLE_ARN',
      exportName: `${id}-role-arn`,
    });
  }
}
