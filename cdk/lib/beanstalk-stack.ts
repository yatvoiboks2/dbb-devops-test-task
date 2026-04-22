import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as elasticbeanstalk from 'aws-cdk-lib/aws-elasticbeanstalk';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3assets from 'aws-cdk-lib/aws-s3-assets';

export interface BeanstalkStackProps extends cdk.StackProps {
  readonly appName: string;
  readonly ecrRepository: ecr.IRepository;
  /**
   * Literal repository name. Must be a concrete string at synth time so that
   * it can be embedded in the initial Dockerrun.aws.json (which becomes a
   * content-addressable S3 asset — tokens inside would not get resolved).
   */
  readonly ecrRepositoryName: string;
  readonly instanceType?: string;
  readonly solutionStackName?: string;
}

export class BeanstalkStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: BeanstalkStackProps) {
    super(scope, id, props);

    if (cdk.Token.isUnresolved(this.account) || cdk.Token.isUnresolved(this.region)) {
      cdk.Annotations.of(this).addWarning(
        'BeanstalkStack is being synthesized without a concrete account/region. ' +
        'The generated Dockerrun.aws.json will contain unresolved tokens and cannot be deployed. ' +
        'Set CDK_DEFAULT_ACCOUNT/CDK_DEFAULT_REGION (or configure `aws` CLI) before `cdk deploy`.',
      );
    }

    const instanceType = props.instanceType ?? 't3.micro';
    const solutionStackName =
      props.solutionStackName ??
      this.node.tryGetContext('solutionStack') ??
      '64bit Amazon Linux 2023 v4.12.1 running Docker';

    const vpc = new ec2.Vpc(this, 'Vpc', {
      maxAzs: 2,
      natGateways: 0,
      subnetConfiguration: [
        { name: 'public', subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
      ],
    });

    const instanceSg = new ec2.SecurityGroup(this, 'InstanceSg', {
      vpc,
      description: `Inbound HTTP/HTTPS to ${props.appName} EB instance`,
      allowAllOutbound: true,
    });
    instanceSg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(80), 'HTTP from internet');
    instanceSg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443), 'HTTPS from internet');

    const instanceRole = new iam.Role(this, 'InstanceRole', {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      description: 'EB EC2 instance role - web tier + ECR pull',
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('AWSElasticBeanstalkWebTier'),
        iam.ManagedPolicy.fromAwsManagedPolicyName('AWSElasticBeanstalkMulticontainerDocker'),
      ],
    });
    props.ecrRepository.grantPull(instanceRole);
    instanceRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: ['ecr:GetAuthorizationToken'],
        resources: ['*'],
      }),
    );

    const instanceProfile = new iam.CfnInstanceProfile(this, 'InstanceProfile', {
      roles: [instanceRole.roleName],
    });

    const serviceRole = new iam.Role(this, 'ServiceRole', {
      assumedBy: new iam.ServicePrincipal('elasticbeanstalk.amazonaws.com'),
      description: 'EB service role - enhanced health + managed updates',
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName(
          'service-role/AWSElasticBeanstalkEnhancedHealth',
        ),
        iam.ManagedPolicy.fromAwsManagedPolicyName(
          'AWSElasticBeanstalkManagedUpdatesCustomerRolePolicy',
        ),
      ],
    });

    const repoUri = `${this.account}.dkr.ecr.${this.region}.amazonaws.com/${props.ecrRepositoryName}`;

    const bundleDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eb-bundle-'));
    fs.writeFileSync(
      path.join(bundleDir, 'Dockerrun.aws.json'),
      JSON.stringify(
        {
          AWSEBDockerrunVersion: '1',
          Image: { Name: `${repoUri}:latest`, Update: 'true' },
          Ports: [{ ContainerPort: 8080 }],
        },
        null,
        2,
      ),
    );

    const sourceBundle = new s3assets.Asset(this, 'InitialBundle', {
      path: bundleDir,
    });
    sourceBundle.grantRead(instanceRole);
    sourceBundle.grantRead(serviceRole);

    const versionsBucket = new s3.Bucket(this, 'VersionsBucket', {
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      versioned: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      lifecycleRules: [
        {
          noncurrentVersionExpiration: cdk.Duration.days(30),
          abortIncompleteMultipartUploadAfter: cdk.Duration.days(7),
        },
      ],
    });
    versionsBucket.grantRead(instanceRole);
    versionsBucket.grantRead(serviceRole);

    const ebApp = new elasticbeanstalk.CfnApplication(this, 'App', {
      applicationName: props.appName,
    });

    const appVersion = new elasticbeanstalk.CfnApplicationVersion(this, 'AppVersionInitial', {
      applicationName: props.appName,
      sourceBundle: {
        s3Bucket: sourceBundle.s3BucketName,
        s3Key: sourceBundle.s3ObjectKey,
      },
      description: 'Initial version - references ECR :latest',
    });
    appVersion.addDependency(ebApp);

    const subnetIds = vpc.publicSubnets.map((s) => s.subnetId).join(',');

    const optionSettings: elasticbeanstalk.CfnEnvironment.OptionSettingProperty[] = [
      { namespace: 'aws:autoscaling:launchconfiguration', optionName: 'IamInstanceProfile', value: instanceProfile.ref },
      { namespace: 'aws:autoscaling:launchconfiguration', optionName: 'InstanceType', value: instanceType },
      { namespace: 'aws:autoscaling:launchconfiguration', optionName: 'SecurityGroups', value: instanceSg.securityGroupId },
      { namespace: 'aws:autoscaling:launchconfiguration', optionName: 'DisableIMDSv1', value: 'true' },
      { namespace: 'aws:autoscaling:asg', optionName: 'MinSize', value: '1' },
      { namespace: 'aws:autoscaling:asg', optionName: 'MaxSize', value: '1' },
      { namespace: 'aws:ec2:vpc', optionName: 'VPCId', value: vpc.vpcId },
      { namespace: 'aws:ec2:vpc', optionName: 'Subnets', value: subnetIds },
      { namespace: 'aws:ec2:vpc', optionName: 'AssociatePublicIpAddress', value: 'true' },
      { namespace: 'aws:elasticbeanstalk:environment', optionName: 'EnvironmentType', value: 'SingleInstance' },
      { namespace: 'aws:elasticbeanstalk:environment', optionName: 'ServiceRole', value: serviceRole.roleName },
      { namespace: 'aws:elasticbeanstalk:healthreporting:system', optionName: 'SystemType', value: 'enhanced' },
      { namespace: 'aws:elasticbeanstalk:application:environment', optionName: 'PORT', value: '8080' },
      { namespace: 'aws:elasticbeanstalk:managedactions', optionName: 'ManagedActionsEnabled', value: 'true' },
      { namespace: 'aws:elasticbeanstalk:managedactions', optionName: 'PreferredStartTime', value: 'Sun:03:00' },
      { namespace: 'aws:elasticbeanstalk:managedactions:platformupdate', optionName: 'UpdateLevel', value: 'minor' },
    ];

    const env = new elasticbeanstalk.CfnEnvironment(this, 'Env', {
      applicationName: props.appName,
      environmentName: `${props.appName}-env`,
      solutionStackName,
      optionSettings,
      versionLabel: appVersion.ref,
    });
    env.addDependency(ebApp);
    env.addDependency(appVersion);

    new cdk.CfnOutput(this, 'EnvironmentUrl', {
      value: `http://${env.attrEndpointUrl}`,
      description: 'Public URL of the EB environment',
    });
    new cdk.CfnOutput(this, 'EnvironmentName', {
      value: env.environmentName!,
      description: 'EB environment name (use for `eb deploy` / CI updates)',
    });
    new cdk.CfnOutput(this, 'ApplicationName', {
      value: props.appName,
      description: 'EB application name',
    });
    new cdk.CfnOutput(this, 'SourceBundleBucket', {
      value: sourceBundle.s3BucketName,
      description: 'S3 bucket where CDK stored the initial app version bundle',
    });
    new cdk.CfnOutput(this, 'VersionsBucketName', {
      value: versionsBucket.bucketName,
      description: 'S3 bucket for CI/CD to upload new EB application versions',
      exportName: `${id}-versions-bucket`,
    });
  }
}
