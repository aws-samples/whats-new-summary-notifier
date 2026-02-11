# Whats New Summary Notifier

**[日本語はこちら](README_ja.md)**

**Whats New Summary Notifier** is a sample implementation of a generative AI application that summarizes the content of AWS What's New and other web articles in multiple languages when there is an update, and delivers the summary to Slack.

This application supports websites that are created with WordPress. For example, I configured related to the Formula 1 news site. You can find configurations in cdk.json.

<p align="center">
  <img alt="example" src="doc/example_en.png" width="50%" />
</p>

## Features

- **AI-Powered Summarization**: Uses Strands Agent SDK with Amazon Bedrock models for intelligent content summarization
- **Multi-Language Support**: Configurable output in Japanese, English, and other languages
- **Automated RSS Monitoring**: Scheduled crawling of RSS feeds for new content
- **Slack Integration**: Direct delivery of summaries to Slack channels
- **Modern Dependencies**: Uses latest compatible versions of all dependencies through automatic resolution

## Architecture

This stack create following architecture.

![architecture](doc/architecture.png)

## Technical Details

### Dependencies

The project uses the following key dependencies:

- **Strands Agent SDK**: For AI model interactions and agent-based processing
- **AWS CDK**: Infrastructure as Code using TypeScript
- **Python 3.12**: Runtime for Lambda functions
- **Docker**: Required for Lambda function builds using AWS SAM

### Lambda Functions

1. **RSS Crawler**: Monitors RSS feeds and stores new entries in DynamoDB
2. **Notify to App**: Processes new entries, generates AI summaries using Strands Agent SDK, and sends notifications to Slack

### Dependency Resolution

The project uses automatic dependency resolution to handle complex package dependencies. The `requirements.txt` files are configured to allow the dependency resolver to find compatible versions of all required packages automatically.

- An environment where you can execute Unix commands (Mac, Linux, ...)
  - If you don't have such an environment, you can also use AWS Cloud9. Please refer to [Preparing the Operating Environment (AWS Cloud9)](DEPLOY.md).
- aws-cdk
  - You can install it with `npm install -g aws-cdk`. For more details, please refer to the [AWS documentation](https://docs.aws.amazon.com/cdk/v2/guide/getting_started.html).
- Docker
  - Docker is required to build Lambda functions using the [`aws-lambda-python-alpha`](https://docs.aws.amazon.com/cdk/api/v2/docs/aws-lambda-python-alpha-readme.html) construct. Please refer to the [Docker documentation](https://docs.docker.com/engine/install/) for more information.

## Deployment Steps
>
> [!IMPORTANT]
> This repository is set up to use the Anthropic Claude 3 Sonnet model in the US East (N. Virginia) region (us-east-1) by default. Please open the [Model access screen (us-east-1)](https://us-east-1.console.aws.amazon.com/bedrock/home?region=us-east-1#/modelaccess), check the Anthropic Claude 3 Sonnet option, and click Save changes.

### Create Webhook URL

Create the Webhook URL required for the notifications.

#### For Slack

Refer to [this documentation](https://slack.com/help/articles/17542172840595-Build-a-workflow--Create-a-workflow-in-Slack) to create the Webhook URL. Select "Add a Variable" and create the following 5 variables, all with the Text data type:

- `rss_time`: The time the article was posted
- `rss_link`: The URL of the article
- `rss_title`: The title of the article
- `summary`: A summary of the article
- `detail`: A bulleted description of the article

### Create AWS Systems Manager Parameter Store

Use Parameter Store to securely store the notification URL.

#### Put into Parameter Store (AWS CLI)

```
aws ssm put-parameter \
  --name "/WhatsNew/URL" \
  --type "SecureString" \
  --value "<Input your Webhook URL >"
```

### Changing the Language Setting (Optional)

This asset is set up to output summaries in Japanese (日本語) by default. If you want to generate output in other languages such as English, open the `cdk.json` file and change the `summarizerName` value inside the `notifiers` object within the `context` section from `AwsSolutionsArchitectJapanese` to `AwsSolutionsArchitectEnglish` or another language. For more information on other configuration options, please refer to the [Deployment Guide](DEPLOY.md). For more information on other configuration options, please refer to the [Deployment Guide](DEPLOY.md).

### Execute the deployment

**Initialize**

If you haven't used CDK in this region before, run the following command:

```bash
cdk bootstrap
```

If you are using a specific AWS profile, add the `--profile` option:

```bash
cdk bootstrap --profile your-profile-name
```

**Verify no errors**

```bash
cdk synth
```

If you are using a specific AWS profile, add the `--profile` option:

```bash
cdk synth --profile your-profile-name
```

**Execute Deployment**

```bash
cdk deploy
```

If you are using a specific AWS profile, add the `--profile` option:

```bash
cdk deploy --profile your-profile-name
```

## Delete Stack

If no longer needed, run the following command to delete the stack:

```bash
cdk destroy
```

If you are using a specific AWS profile, add the `--profile` option:

```bash
cdk destroy --profile your-profile-name
```

By default, some resources such as the Amazon DynamoDB table are set to not be deleted.
If you need to completely delete everything, you will need to access the remaining resources and manually delete them.

## Troubleshooting

### Dependency Conflicts

If you encounter dependency conflicts during deployment, the system automatically resolves compatible versions. The requirements.txt files are configured to allow automatic dependency resolution.

### Docker Build Issues

- Ensure Docker is running before executing CDK commands
- The build process uses AWS SAM build images which are automatically downloaded
- If builds fail, try running `cdk synth` first to verify the configuration

### Common Issues

1. **Model Access**: Ensure you have enabled the required Bedrock models in your AWS region
2. **Profile Configuration**: Always use the `--profile` option if you're using named AWS profiles
3. **Region Consistency**: Ensure all resources are deployed in the same AWS region

## Change Log

### Recent Updates

- **Strands Agent SDK Integration**: Migrated from direct Bedrock API calls to Strands Agent SDK for improved AI model interactions
- **Dependency Management**: Improved dependency resolution to prevent conflicts between packages
- **Documentation**: Added comprehensive troubleshooting guide and technical details
- **Profile Support**: Enhanced all CDK and AWS CLI commands with `--profile` option support

### Migration Notes

If you're upgrading from a previous version:
1. The Lambda functions now use Strands Agent SDK instead of direct Bedrock API calls
2. Dependencies are automatically resolved - no manual version management required
3. All CDK commands now support AWS profile specification

## Third Party Services

This code interacts with Slack which has terms published at [Terms Page (Slack)](https://slack.com/main-services-agreement), and pricing described at [Pricing Page (Slack)](https://slack.com/pricing). You should be familiar with the pricing and confirm that your use case complies with the terms before proceeding.
