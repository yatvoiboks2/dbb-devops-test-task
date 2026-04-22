#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { EcrStack } from '../lib/ecr-stack';
import { BeanstalkStack } from '../lib/beanstalk-stack';
import { GithubOidcStack } from '../lib/github-oidc-stack';

const app = new cdk.App();

const appName = app.node.tryGetContext('appName') ?? 'dbb-health';
const ecrRepoName = app.node.tryGetContext('ecrRepoName') ?? 'dbb-health-app';

const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION ?? 'eu-central-1',
};

const ecr = new EcrStack(app, `${appName}-ecr`, {
  env,
  repositoryName: ecrRepoName,
  description: 'ECR repository for DBB health web application',
});

const beanstalk = new BeanstalkStack(app, `${appName}-beanstalk`, {
  env,
  appName,
  ecrRepository: ecr.repository,
  ecrRepositoryName: ecrRepoName,
  description: 'Elastic Beanstalk environment running the Docker image from ECR',
});

const githubRepo = app.node.tryGetContext('githubRepo') as string | undefined;
if (githubRepo) {
  new GithubOidcStack(app, `${appName}-oidc`, {
    env,
    githubRepo,
    existingOidcProviderArn: app.node.tryGetContext('existingOidcProviderArn'),
    ecrRepositoryArn: ecr.repository.repositoryArn,
    versionsBucketName: cdk.Fn.importValue(`${appName}-beanstalk-versions-bucket`),
    ebApplicationName: appName,
    description: 'GitHub Actions OIDC trust + deploy role',
  }).addDependency(beanstalk);
}

cdk.Tags.of(app).add('Project', 'dbb-devops-test');
cdk.Tags.of(app).add('ManagedBy', 'AWS-CDK');
