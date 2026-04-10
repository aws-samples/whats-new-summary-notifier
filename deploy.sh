#!/usr/bin/env bash
set -euo pipefail

#=============================================================================
# deploy.sh — Whats New Summary Notifier deployment via CodeBuild
#
# Usage:
#   Interactive (default):
#     bash deploy.sh
#
#   Non-interactive:
#     bash deploy.sh \
#       --webhook-url "https://hooks.slack.com/..." \
#       --destination slack \
#       --language japanese \
#       --tenant test
#
#   Destroy:
#     bash deploy.sh --destroy [--tenant test]
#=============================================================================

REPO_URL="https://github.com/aws-samples/whats-new-summary-notifier.git"
PROJECT_PREFIX="whats-new-summary-notifier"
CODEBUILD_IMAGE="aws/codebuild/amazonlinux2-x86_64-standard:5.0"

# Defaults
TENANT=""
DESTINATION="slack"
LANGUAGE="japanese"
WEBHOOK_URL=""
SSM_PARAM_NAME=""
DESTROY=false
NON_INTERACTIVE=false
CONFIG_FILE=""

#-----------------------------------------------------------------------------
# Parse CLI arguments
#-----------------------------------------------------------------------------
while [[ $# -gt 0 ]]; do
  case $1 in
    --tenant)         TENANT="$2"; shift 2 ;;
    --destination)    DESTINATION="$2"; shift 2 ;;
    --language)       LANGUAGE="$2"; shift 2 ;;
    --webhook-url)    WEBHOOK_URL="$2"; shift 2 ;;
    --ssm-param)      SSM_PARAM_NAME="$2"; shift 2 ;;
    --config)         CONFIG_FILE="$2"; shift 2 ;;
    --destroy)        DESTROY=true; shift ;;
    --non-interactive) NON_INTERACTIVE=true; shift ;;
    -h|--help)        usage; exit 0 ;;
    *)                echo "Unknown option: $1"; exit 1 ;;
  esac
done

usage() {
  cat <<'EOF'
Usage: bash deploy.sh [OPTIONS]

Options:
  --tenant NAME         Tenant name for multi-tenant deployment (optional)
  --destination TYPE    Notification destination: slack or teams (default: slack)
  --language LANG       Summary language: japanese or english (default: japanese)
  --webhook-url URL     Webhook URL for notifications
  --ssm-param NAME      SSM Parameter Store name (default: auto-generated)
  --config FILE         Tenant config JSON file (e.g., tenants/test.json)
  --destroy             Destroy the stack instead of deploying
  --non-interactive     Skip interactive prompts
  -h, --help            Show this help
EOF
}

#-----------------------------------------------------------------------------
# Interactive prompts
#-----------------------------------------------------------------------------
ask() {
  local prompt="$1" default="$2" var="$3"
  if [[ "${!var}" != "" ]]; then return; fi
  read -rp "$prompt [$default]: " input
  eval "$var=\"${input:-$default}\""
}

ask_required() {
  local prompt="$1" var="$2"
  if [[ "${!var}" != "" ]]; then return; fi
  while true; do
    read -rp "$prompt: " input
    if [[ -n "$input" ]]; then
      eval "$var=\"$input\""
      return
    fi
    echo "  This field is required."
  done
}

if [[ -n "$CONFIG_FILE" && -f "$CONFIG_FILE" ]]; then
  echo "Loading config from: $CONFIG_FILE"
  TENANT="${TENANT:-$(python3 -c "import json; d=json.load(open('$CONFIG_FILE')); print(d.get('tenant',''))")}"
fi

if [[ "$NON_INTERACTIVE" == false && "$DESTROY" == false ]]; then
  echo "============================================"
  echo " Whats New Summary Notifier - Deploy Setup"
  echo "============================================"
  echo ""

  ask "Tenant name (leave empty for default)" "" TENANT
  echo ""
  echo "Notification destination:"
  echo "  1) Slack"
  echo "  2) Microsoft Teams"
  if [[ -z "$DESTINATION" || "$DESTINATION" == "slack" ]]; then
    read -rp "Select [1]: " dest_choice
  else
    read -rp "Select [2]: " dest_choice
  fi
  case "${dest_choice:-1}" in
    2) DESTINATION="teams" ;;
    *) DESTINATION="slack" ;;
  esac

  echo ""
  echo "Summary language:"
  echo "  1) Japanese"
  echo "  2) English"
  read -rp "Select [1]: " lang_choice
  case "${lang_choice:-1}" in
    2) LANGUAGE="english" ;;
    *) LANGUAGE="japanese" ;;
  esac

  echo ""
  ask_required "Webhook URL" WEBHOOK_URL
fi

#-----------------------------------------------------------------------------
# Derived values
#-----------------------------------------------------------------------------
if [[ -n "$TENANT" ]]; then
  SSM_PARAM_NAME="${SSM_PARAM_NAME:-/WhatsNew/URL/$TENANT}"
  CB_PROJECT_NAME="${PROJECT_PREFIX}-${TENANT}"
  STACK_NAME="WhatsNewSummaryNotifier-${TENANT}"
else
  SSM_PARAM_NAME="${SSM_PARAM_NAME:-/WhatsNew/URL}"
  CB_PROJECT_NAME="${PROJECT_PREFIX}"
  STACK_NAME="WhatsNewSummaryNotifierStack"
fi

case "$LANGUAGE" in
  english)  SUMMARIZER_NAME="AwsSolutionsArchitectEnglish" ;;
  *)        SUMMARIZER_NAME="AwsSolutionsArchitectJapanese" ;;
esac

ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
REGION=$(aws configure get region || echo "us-east-1")

#-----------------------------------------------------------------------------
# Destroy mode
#-----------------------------------------------------------------------------
if [[ "$DESTROY" == true ]]; then
  echo "Destroying stack: $STACK_NAME"

  # Build override for destroy
  ENV_OVERRIDES=$(cat <<EOJSON
[
  {"name":"TENANT","value":"${TENANT}","type":"PLAINTEXT"},
  {"name":"DEPLOY_ACTION","value":"destroy","type":"PLAINTEXT"}
]
EOJSON
)

  BUILDSPEC_OVERRIDE=$(cat <<'EOBS'
version: 0.2
phases:
  install:
    runtime-versions:
      nodejs: 22
    commands:
      - npm install -g aws-cdk
      - npm ci
  build:
    commands:
      - |
        CDK_ARGS=""
        if [ -n "$TENANT" ]; then CDK_ARGS="-c tenant=$TENANT"; fi
        npx cdk destroy --force $CDK_ARGS
EOBS
)

  BUILD_ID=$(aws codebuild start-build \
    --project-name "$CB_PROJECT_NAME" \
    --environment-variables-override "$ENV_OVERRIDES" \
    --buildspec-override "$BUILDSPEC_OVERRIDE" \
    --query 'build.id' --output text 2>/dev/null || echo "")

  if [[ -z "$BUILD_ID" ]]; then
    echo "CodeBuild project not found. Nothing to destroy."
    exit 0
  fi

  echo "Build started: $BUILD_ID"
  echo "Waiting for completion..."
  aws codebuild batch-get-builds --ids "$BUILD_ID" \
    --query 'builds[0].buildStatus' --output text
  echo ""

  # Cleanup CodeBuild project and role
  echo "Cleaning up CodeBuild project..."
  aws codebuild delete-project --name "$CB_PROJECT_NAME" 2>/dev/null || true
  aws iam delete-role-policy --role-name "${CB_PROJECT_NAME}-role" --policy-name deploy-policy 2>/dev/null || true
  aws iam delete-role --role-name "${CB_PROJECT_NAME}-role" 2>/dev/null || true

  echo "Cleanup SSM parameter..."
  aws ssm delete-parameter --name "$SSM_PARAM_NAME" 2>/dev/null || true

  echo "Done."
  exit 0
fi

#-----------------------------------------------------------------------------
# Store Webhook URL in SSM Parameter Store
#-----------------------------------------------------------------------------
echo ""
echo "Storing Webhook URL in SSM Parameter Store ($SSM_PARAM_NAME)..."
aws ssm put-parameter \
  --name "$SSM_PARAM_NAME" \
  --type "SecureString" \
  --value "$WEBHOOK_URL" \
  --overwrite > /dev/null

#-----------------------------------------------------------------------------
# Create CodeBuild service role
#-----------------------------------------------------------------------------
ROLE_NAME="${CB_PROJECT_NAME}-role"
echo "Creating CodeBuild service role ($ROLE_NAME)..."

TRUST_POLICY=$(cat <<EOJSON
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": {"Service": "codebuild.amazonaws.com"},
    "Action": "sts:AssumeRole"
  }]
}
EOJSON
)

ROLE_ARN=$(aws iam create-role \
  --role-name "$ROLE_NAME" \
  --assume-role-policy-document "$TRUST_POLICY" \
  --query 'Role.Arn' --output text 2>/dev/null || \
  aws iam get-role --role-name "$ROLE_NAME" --query 'Role.Arn' --output text)

DEPLOY_POLICY=$(cat <<EOJSON
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "logs:CreateLogGroup","logs:CreateLogStream","logs:PutLogEvents",
        "s3:*",
        "cloudformation:*",
        "iam:*",
        "lambda:*",
        "dynamodb:*",
        "events:*",
        "ssm:GetParameter*","ssm:DescribeParameters",
        "bedrock:*",
        "sts:AssumeRole",
        "ecr:*"
      ],
      "Resource": "*"
    }
  ]
}
EOJSON
)

aws iam put-role-policy \
  --role-name "$ROLE_NAME" \
  --policy-name "deploy-policy" \
  --policy-document "$DEPLOY_POLICY"

echo "Waiting for IAM role propagation..."
sleep 10

#-----------------------------------------------------------------------------
# Create/Update CodeBuild project
#-----------------------------------------------------------------------------
echo "Creating CodeBuild project ($CB_PROJECT_NAME)..."

aws codebuild create-project \
  --name "$CB_PROJECT_NAME" \
  --source "{\"type\":\"GITHUB\",\"location\":\"$REPO_URL\",\"buildspec\":\"buildspec.yml\"}" \
  --artifacts '{"type":"NO_ARTIFACTS"}' \
  --environment "{\"type\":\"LINUX_CONTAINER\",\"image\":\"$CODEBUILD_IMAGE\",\"computeType\":\"BUILD_GENERAL1_MEDIUM\",\"privilegedMode\":true}" \
  --service-role "$ROLE_ARN" \
  --timeout-in-minutes 30 > /dev/null 2>&1 || \
aws codebuild update-project \
  --name "$CB_PROJECT_NAME" \
  --source "{\"type\":\"GITHUB\",\"location\":\"$REPO_URL\",\"buildspec\":\"buildspec.yml\"}" \
  --environment "{\"type\":\"LINUX_CONTAINER\",\"image\":\"$CODEBUILD_IMAGE\",\"computeType\":\"BUILD_GENERAL1_MEDIUM\",\"privilegedMode\":true}" \
  --service-role "$ROLE_ARN" > /dev/null

#-----------------------------------------------------------------------------
# Build CDK context override JSON
#-----------------------------------------------------------------------------
NOTIFIERS_JSON=$(cat <<EOJSON
{
  "AwsWhatsNew": {
    "destination": "$DESTINATION",
    "summarizerName": "$SUMMARIZER_NAME",
    "webhookUrlParameterName": "$SSM_PARAM_NAME",
    "rssUrl": {"What's new": "https://aws.amazon.com/about-aws/whats-new/recent/feed/"}
  }
}
EOJSON
)

CDK_CONTEXT_JSON=$(python3 -c "
import json
ctx = {
    'notifiers': json.loads('''$NOTIFIERS_JSON''')
}
print(json.dumps(ctx))
")

ENV_OVERRIDES=$(cat <<EOJSON
[
  {"name":"TENANT","value":"${TENANT}","type":"PLAINTEXT"},
  {"name":"CONFIG_FILE","value":"${CONFIG_FILE}","type":"PLAINTEXT"},
  {"name":"CDK_CONTEXT_JSON","value":$(python3 -c "import json; print(json.dumps('''$CDK_CONTEXT_JSON'''))"),"type":"PLAINTEXT"}
]
EOJSON
)

#-----------------------------------------------------------------------------
# Start build
#-----------------------------------------------------------------------------
echo ""
echo "Starting CodeBuild deployment..."
echo "  Stack:       $STACK_NAME"
echo "  Destination: $DESTINATION"
echo "  Language:    $LANGUAGE"
echo "  SSM Param:   $SSM_PARAM_NAME"
echo ""

BUILD_ID=$(aws codebuild start-build \
  --project-name "$CB_PROJECT_NAME" \
  --environment-variables-override "$ENV_OVERRIDES" \
  --query 'build.id' --output text)

echo "Build started: $BUILD_ID"
echo ""

#-----------------------------------------------------------------------------
# Tail build logs
#-----------------------------------------------------------------------------
LOG_GROUP="/aws/codebuild/${CB_PROJECT_NAME}"
# Extract build number from build ID (project:build-id)
BUILD_NUM="${BUILD_ID#*:}"

echo "Waiting for logs to become available..."
sleep 15

# Poll build status and stream logs
NEXT_TOKEN=""
while true; do
  STATUS=$(aws codebuild batch-get-builds --ids "$BUILD_ID" \
    --query 'builds[0].buildStatus' --output text 2>/dev/null || echo "IN_PROGRESS")

  # Try to get logs
  if [[ -z "$NEXT_TOKEN" ]]; then
    LOG_OUTPUT=$(aws logs get-log-events \
      --log-group-name "$LOG_GROUP" \
      --log-stream-name "$BUILD_NUM" \
      --start-from-head \
      --output json 2>/dev/null || echo '{"events":[],"nextForwardToken":""}')
  else
    LOG_OUTPUT=$(aws logs get-log-events \
      --log-group-name "$LOG_GROUP" \
      --log-stream-name "$BUILD_NUM" \
      --next-token "$NEXT_TOKEN" \
      --output json 2>/dev/null || echo '{"events":[],"nextForwardToken":""}')
  fi

  # Print new log lines
  echo "$LOG_OUTPUT" | python3 -c "
import sys, json
data = json.load(sys.stdin)
for e in data.get('events', []):
    print(e.get('message', ''), end='')
" 2>/dev/null || true

  NEW_TOKEN=$(echo "$LOG_OUTPUT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('nextForwardToken',''))" 2>/dev/null || echo "")
  if [[ -n "$NEW_TOKEN" ]]; then
    NEXT_TOKEN="$NEW_TOKEN"
  fi

  if [[ "$STATUS" != "IN_PROGRESS" ]]; then
    echo ""
    echo "============================================"
    echo " Build finished: $STATUS"
    echo "============================================"
    if [[ "$STATUS" == "SUCCEEDED" ]]; then
      echo ""
      echo "Deployment successful!"
      echo "Stack: $STACK_NAME"
    else
      echo ""
      echo "Deployment failed. Check the logs above for details."
      exit 1
    fi
    break
  fi

  sleep 5
done
