# Deployment Options
This asset uses the AWS CDK context to configure the settings.

You can change the settings by modifying the values under the `context` section in the [cdk.json](cdk.json) file. The details of each configuration item are as follows:

## Common Settings
* `modelRegion`: The region to use Amazon Bedrock. Enter the region code of the region you want to use from among the regions where Amazon Bedrock is available.
* `modelId`: The model ID of the base model to be used with Amazon Bedrock. It supports Anthropic Claude 3 and earlier versions. Refer to the documentation for the model ID of each model.

## summarizers
Configure the prompt for summarizing the input to the generative AI.

* `outputLanguage`: The language of the model output.
* `persona`: The role (persona) to be given to the model.

## notifiers
Configure the delivery settings to the application.

* `destination`: The name of application to post to. Set either `slack` or `teams` according to the destination.
* `summarizerName`: The name of the summarizer to use for delivery.
* `webhookUrlParameterName`: The name of the AWS Systems Manager Parameter Store parameter that stores the Webhook URL.
* `rssUrl`: The RSS feed URL of the website from which you want to get the latest information. Multiple URLs can be specified.
* `schedule` (optional): The interval for retrieving the RSS feed in CRON format. If this parameter is not specified, the feed will be retrieved at 00 minutes every hour. In the example below, the feed will be retrieved every 15 minutes.

```json
...
"schedule": {
  "minute": "0/15",
  "hour": "*",
  "day": "*",
  "month": "*",
  "year": "*"
}
```

# Preparing the Deployment Environment (AWS Cloud9)
This procedure creates a development environment on AWS with the necessary tools installed.
The environment is built using AWS Cloud9.
For more details on AWS Cloud9, please refer to [What is AWS Cloud9?](https://docs.aws.amazon.com/cloud9/latest/user-guide/welcome.html).

1. Open [CloudShell](https://console.aws.amazon.com/cloudshell/home).
2. Clone this repository.
```bash
git clone https://github.com/aws-samples/cloud9-setup-for-prototyping
```
3. Move to the directory
```bash
cd cloud9-setup-for-prototyping
```
4. Change volume capacities as needed for cost optimization.
```bash
cat <<< $(jq  '.volume_size = 20'  params.json )  > params.json
```
5. Run the script.
```bash
./bin/bootstrap
```
6. Move to [Cloud9](https://console.aws.amazon.com/cloud9/home), and click "Open IDE ".

> [!NOTE]
> The AWS Cloud9 environment created in this procedure will incur pay-per-use EC2 charges based on usage time.
> It is set to automatically stop after 30 minutes of inactivity, but the charges for the instance volume (Amazon EBS) will continue to accrue.
> If you want to minimize charges, please delete the environment after deployment of the asset, following the instructions in [Deleting an environment in AWS Cloud9](https://docs.aws.amazon.com/cloud9/latest/user-guide/delete-environment.html).