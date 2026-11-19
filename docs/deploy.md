# Deploying OrcaSonar

Every step to deploy OrcaSonar: the prerequisites in each stage account, the two pipelines in the toolchain account,
and connecting docs.umccr.org. Operating it afterwards is in the [runbook](runbook.md). docs.umccr.org is deployed
from `umccr/docs-platform`, whose guide is
[docs/site/deploy.md](https://github.com/umccr/docs-platform/blob/main/docs/site/deploy.md).

> The commands below print account IDs, ARNs, bucket names and tokens. Keep them in your terminal or a private note:
> never paste them into this repository, a pull request or an issue.

## What gets deployed

| Piece                                                                                                                                                                                    | Account          | Deployed by                                                  |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- | ------------------------------------------------------------ |
| The toolchain stacks `OrcaSonarStatefulStack` and `OrcaSonarStatelessStack` (`infrastructure/toolchain/`): the pipelines `UMCCR-OrcaSonarStateful` and `UMCCR-OrcaSonarStateless`        | toolchain        | `cdk deploy` once by hand; then each pipeline updates itself |
| The stateful stack: the Sonar KMS key (`alias/orcasonar`), both buckets, table `OrcaSonarTable-<stage>`, knowledge base and guardrail `orcasonar-<stage>`, the `/orcasonar/*` parameters | dev (beta), prod | the stateful pipeline; beta also by hand                     |
| The stateless stack: the API at `sonar.<stage zone>` with WAF, the six functions, budget `orcasonar-bedrock-<stage>` with its action, the alarms and the alerts topic                    | dev (beta), prod | the stateless pipeline; beta also by hand                    |

The stage stacks have the same CloudFormation names in every account, `UMCCR-OrcaSonarStatefulStack` and
`UMCCR-OrcaSonarStatelessStack`. `cdk deploy` selects them by construct path, such as
`OrcaSonarStatefulStack/DeploymentPipeline/Beta/OrcaSonarStatefulStack`, with `Prod` instead of `Beta` for prod. The
stateless stack reads the SSM parameters the stateful stack writes, so **in every account the stateful stack deploys
first**.

Each pipeline builds `umccr/orcasonar` `main`, runs the tests, deploys beta, then waits at **PromoteToProd**, the first
action of its prod stage. Changes start one pipeline or both:

| A change to                                                                                             | Starts                 |
| ------------------------------------------------------------------------------------------------------- | ---------------------- |
| `app/`                                                                                                  | the stateless pipeline |
| `infrastructure/stage/stateful-stack.ts`, `infrastructure/toolchain/stateful-stack.ts`                  | the stateful pipeline  |
| `infrastructure/stage/stateless-stack.ts`, `infrastructure/toolchain/stateless-stack.ts`                | the stateless pipeline |
| anything else, such as `infrastructure/stage/config.ts`, `constants.ts`, `package.json` or the lockfile | both                   |
| `docs/`, or Markdown anywhere                                                                           | neither                |

## Before you start

| For                                                                        | You need                                                                                              |
| -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Checks and by-hand deploys to a stage                                      | admin on the stage account through AWS SSO                                                            |
| Accepting the Claude model agreements (manual, once per account and model) | an admin of the stage account who may subscribe in AWS Marketplace and accept licence terms for UMCCR |
| Anthropic's use-case form (manual, once)                                   | an organisation administrator, in the management account; or an admin of each stage account           |
| The toolchain stacks and pipelines                                         | admin on the toolchain (bastion) account                                                              |
| The data-retention setting and its SCP                                     | an AWS organisation administrator                                                                     |
| The AWS Connector app's repository access                                  | an owner of the umccr GitHub organisation                                                             |

The examples use the SSO profiles `bastion-admin` for the toolchain account and `dev` for dev; use yours if they are
named differently, and the prod profile for prod.

```sh
aws sso login --profile bastion-admin && export AWS_PROFILE=bastion-admin   # the toolchain account
aws sso login --profile dev && export AWS_PROFILE=dev                       # a stage account
export AWS_REGION=ap-southeast-2
aws sts get-caller-identity --query Account --output text                   # check it is the account you expect
```

**Tools:** the AWS CLI v2, Node.js 24 or later, pnpm through Corepack (`corepack enable`), which uses the version
`package.json` pins, [pre-commit](https://pre-commit.com), whose git hook `make install` installs, `git`, `curl` and
`dig`.

A read-only check of the toolchain, dev and prod accounts on 2026-10-21 found every prerequisite below in place,
except two in prod: the Claude model agreements and someone to hear the alerts. dev's data retention was `inherit`.
In prod, the docs platform's `docs-publisher` role already has its grants on the ingest bucket, but every release
skips the export until `/orcasonar/ingest-bucket-name` exists there. stg holds no OrcaSonar resources.

## Order

```text
1. Prerequisites in each stage account: the Claude model agreements (manual), data retention, the docs platform's
   Cognito client
2. Pre-flight checks, read-only: the toolchain account and each stage account
3. dev, optional: deploy both stage stacks by hand from a branch, and try them
4. With the code on main, deploy the stateful pipeline; wait until it has deployed beta
5. Deploy the stateless pipeline
6. Connect docs.umccr.org: documents, then the chat
7. prod: steps 1 and 2 there, then PromoteToProd on the stateful pipeline, then on the stateless one; then release
   each docs site once more, so prod's index gets its documents
```

---

## Step 1: Prerequisites in each stage account

### Model access

Answers come from Claude Sonnet 5 through the Australian cross-Region inference profile, and Claude Haiku 4.5 is
allowed too. Both profiles must be active, their IDs must match `ANSWER_MODEL_ID` and `ALLOWED_MODEL_IDS` in
`infrastructure/stage/config.ts`, and the models behind them must be authorised for the account:

```sh
aws bedrock list-inference-profiles --output table --query \
  "inferenceProfileSummaries[?starts_with(inferenceProfileId, 'au.anthropic')].[inferenceProfileId, status]"
for region in ap-southeast-2 ap-southeast-4; do
  for model in anthropic.claude-sonnet-5 anthropic.claude-haiku-4-5-20251001-v1:0; do
    aws bedrock get-foundation-model-availability --region "$region" --model-id "$model" --output text \
      --query "[modelId, agreementAvailability.status, authorizationStatus, entitlementAvailability]"
  done
done   # each: AVAILABLE, AUTHORIZED, AVAILABLE
```

If a profile ID differs, change `config.ts` before deploying.

Claude models on Bedrock are third-party models, sold through AWS Marketplace. Before an account can call one, it
needs Anthropic's use-case form, filled in once, and a Marketplace agreement for each model, which accepts the model's
[licence terms](https://aws.amazon.com/legal/bedrock/third-party-models/) and starts pay-per-use billing through the
management account's consolidated billing; nothing is charged until the model is called. An agreement covers one model
in one account, in every Region where the model is offered, so dev and prod each accept Sonnet 5 and Haiku 4.5 for
themselves. The form covers every Anthropic model, and, submitted in the management account, every member account;
Melbourne, an opt-in Region, may ask for it again.

Bedrock creates an agreement itself on the first call by someone who may subscribe in Marketplace
(`aws-marketplace:Subscribe`, `Unsubscribe` and `ViewSubscriptions`). The chat role deliberately may not, because a
service role should not accept licence terms or start billing for UMCCR, and CloudFormation has no resource for
agreements or the form (checked on 2026-10-15, with aws-cdk-lib 2.273). So until an administrator accepts, every
answer fails: `agreementAvailability` stays `NOT_AVAILABLE`, and the log says the role "is not authorized to perform
the required AWS Marketplace actions". Search works meanwhile. Once an agreement exists, the chat role calls the model
with its own permissions.

Accept once per account and model: before a stage's first answer, and before `config.ts` moves to a model the stage
has not accepted ([runbook](runbook.md#move-to-another-claude-model)).

#### Accepting: the manual steps

**Who:** an administrator of the stage account who may subscribe in AWS Marketplace (`AdministratorAccess` includes
it) and may accept licence terms for UMCCR, or has the go-ahead from whoever may.

1. **Check what is missing**: run the check above, then check for the use-case form.

   ```sh
   export AWS_PROFILE=<the stage's admin profile> AWS_REGION=ap-southeast-2
   aws bedrock get-use-case-for-model-access --query 'length(formData)'   # ResourceNotFoundException: not submitted
   ```

2. **Submit Anthropic's use-case form, once**, best in the organisation's management account, which every member
   account inherits; otherwise in each stage account. In the console, the form appears when you first open an
   Anthropic model in the Bedrock model catalog. With the CLI:

   ```sh
   cat > /tmp/use-case.json <<'EOF'
   {"companyName": "<organisation name>", "companyWebsite": "<website>", "intendedUsers": "0",
    "industryOption": "<industry>", "otherIndustryOption": "",
    "useCases": "Internal documentation assistant: answers UMCCR staff questions from UMCCR's documentation, with sources."}
   EOF
   aws bedrock put-use-case-for-model-access --form-data fileb:///tmp/use-case.json
   ```

   `intendedUsers` `"0"` means internal users only. The console's form lists the industry options.

3. **Read each model's licence terms.** This only prints links to them:

   ```sh
   for model in anthropic.claude-sonnet-5 anthropic.claude-haiku-4-5-20251001-v1:0; do
     aws bedrock list-foundation-model-agreement-offers --model-id "$model" \
       --query 'offers[0].termDetails.legalTerm.url' --output text
   done
   ```

4. **Accept them**, model by model:

   ```sh
   for model in anthropic.claude-sonnet-5 anthropic.claude-haiku-4-5-20251001-v1:0; do
     offer=$(aws bedrock list-foundation-model-agreement-offers --model-id "$model" \
       --query 'offers[0].offerToken' --output text)
     aws bedrock create-foundation-model-agreement --model-id "$model" --offer-token "$offer"
   done
   ```

   Or, in the console, open the model in the Bedrock model catalog in ap-southeast-2 and send one short message from
   the playground: that first call creates the agreement.

5. **Check again**: the check above should show `AVAILABLE` in both Regions. Right after the use-case form, an
   agreement can stay `PENDING` for a while, and AWS emails when it is ready. If `agreementAvailability` stays
   `NOT_AVAILABLE` in Melbourne, repeat step 2 with `--region ap-southeast-4`.

6. **Ask a question** in the chat panel. Nothing needs redeploying, and CloudTrail shows `ConverseStream` without an
   error:

   ```sh
   aws cloudtrail lookup-events --lookup-attributes AttributeKey=EventName,AttributeValue=ConverseStream \
     --max-results 5 --query 'Events[].CloudTrailEvent' --output text | grep -o '"errorCode":"[^"]*"' || echo "no errors"
   ```

7. **Record it** here:

| Stage | Use-case form                                    | Claude Sonnet 5       | Claude Haiku 4.5      |
| ----- | ------------------------------------------------ | --------------------- | --------------------- |
| dev   | submitted in both Regions (2026-10-15)           | accepted (2026-10-15) | accepted (2026-10-15) |
| prod  | inherited if the management account submitted it | to do                 | to do                 |

To stop an account using a model later, deny it in IAM or with a service control policy. Deleting the agreement is
not enough: the next call by someone who may subscribe creates it again.

### The organisation's region policy

The `au.` profiles send each request to Sydney (ap-southeast-2) or Melbourne (ap-southeast-4), and neither model can
be called in Sydney alone. A service control policy that denies ap-southeast-4 therefore refuses the answers: `/chat`
answers `unavailable`, and the chat function's log shows `AccessDeniedException` with "an explicit deny in a service
control policy". UMCCR's list of approved regions held Sydney only until 2026-10-15, and holds Sydney and Melbourne
since. Checked in dev that day: calls in Melbourne succeed, and calls outside Australia are still denied.

```sh
aws ec2 describe-availability-zones --region ap-southeast-4 --query 'AvailabilityZones[0].ZoneName'   # allowed
aws ec2 describe-availability-zones --region ap-southeast-1   # "explicit deny in a service control policy"
```

If the organisation narrows the list to Sydney again, the exception AWS describes for
[cross-Region inference in multi-account environments](https://aws.amazon.com/blogs/machine-learning/enable-amazon-bedrock-cross-region-inference-in-multi-account-environments/)
lets the Australian profiles through while the rest of Melbourne stays denied:

```json
"ArnNotLike": { "bedrock:InferenceProfileArn": "arn:aws:bedrock:*:*:inference-profile/au.*" }
```

To see whether a policy is refusing answers, with that account's credentials:

```sh
aws cloudtrail lookup-events --lookup-attributes AttributeKey=EventName,AttributeValue=ConverseStream \
  --max-results 10 --query 'Events[].CloudTrailEvent' --output text | grep -o '"errorMessage":"[^"]*"'
```

### Data retention

OrcaSonar is designed for an account that keeps no prompts or answers at Bedrock: data-retention mode `none` in
ap-southeast-2, with an SCP that stops anyone changing it, so a model that requires retention refuses to run instead of
quietly retaining. An organisation administrator decides and sets both; nothing in this repository changes them.

```sh
aws bedrock get-account-data-retention   # mode: none is the design; inherit is what dev has today
```

### Parameters

| Parameter                                          | Written by                                         | Used for                                                                               |
| -------------------------------------------------- | -------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `/umccr/certificate_arn`                           | the account's shared setup                         | the API's custom domain: a certificate in ap-southeast-2 covering `sonar.<stage zone>` |
| `/hosted_zone/umccr/id`, `/hosted_zone/umccr/name` | the account's shared setup                         | the `sonar` DNS record                                                                 |
| `/data_portal/client/cog_user_pool_id`             | `umccr/infrastructure` `cognito_aai`               | the authorizer's user pool                                                             |
| `/cognito/docs-app/app-client-id`                  | `umccr/infrastructure` `cognito_aai/app_docs.tf`   | the docs chat panel's client, applied as the docs-platform guide's step 1 describes    |
| `/orcaui/cog_app_client_id_stage`                  | `umccr/infrastructure` `cognito_aai/app_orcaui.tf` | OrcaUI's client; already there wherever OrcaUI runs                                    |
| `/cognito/localhost-app/app-client-id`             | `umccr/infrastructure` `cognito_aai/app_local.tf`  | dev only: the client for portal apps run on a developer's machine                      |
| `/orcasonar/*`, eight of them                      | the stateful stack                                 | the stateless stack: the key, table, buckets, knowledge base, data source, guardrail   |
| `/orcasonar/ingest-bucket-name`                    | the stateful stack                                 | the docs publish steps, too                                                            |
| `/orcasonar/api-url`                               | the stateless stack                                | reference only: the docs platform names the API in its own `SONAR_API_URLS`            |

### API Gateway logging

Access logs need API Gateway's account-level CloudWatch role, which another stack in the account sets. Without it, a
stage's deploy fails with access logs on (`ACCESS_LOGS` in `infrastructure/stage/config.ts`). Both stages have the
role and their access logs on (2026-10-21), and execution logs stay off. Check a new account first:

```sh
aws apigateway get-account --query cloudwatchRoleArn --output text   # None: not set
```

### Alerts

Every alarm, and the budget's notices, go to one SNS topic in each stage: the stateless stack's `AlertsTopicArn`
output. Nobody hears them until someone subscribes, so before prod do one of these:

- **Email**: add a team address, not a person's, to the stage's `ALERT_EMAILS` in `infrastructure/stage/config.ts`.
  After the deploy, the address must confirm the subscription before it hears anything.
- **Slack**: in the stage account's AWS Chatbot console, add the topic to the Slack channel configuration that should
  hear it.

The [verification checklist](#verification-checklist) then checks that an alarm reaches someone.

## Step 2: Pre-flight checks

All of these only read.

### The toolchain account

```sh
aws sso login --profile bastion-admin && export AWS_PROFILE=bastion-admin AWS_REGION=ap-southeast-2

# a) The parameters both toolchain stacks read: InvalidParameters must be empty
aws ssm get-parameters --query InvalidParameters --names \
  codestar_github_arn /chatbot_arn/slack/alerts-build /cdk-bootstrap/hnb659fds/version

# b) The GitHub connection the pipelines clone through: AVAILABLE
aws codeconnections get-connection --query Connection.ConnectionStatus --output text \
  --connection-arn "$(aws ssm get-parameter --name codestar_github_arn --query Parameter.Value --output text)"

# c) First deploy only: none of these exists yet
aws cloudformation describe-stacks --stack-name OrcaSonarStatefulStack
aws cloudformation describe-stacks --stack-name OrcaSonarStatelessStack
aws codepipeline get-pipeline --name UMCCR-OrcaSonarStateful
aws codepipeline get-pipeline --name UMCCR-OrcaSonarStateless
```

### Each stage account

```sh
aws sso login --profile dev && export AWS_PROFILE=dev AWS_REGION=ap-southeast-2

# a) The parameters the stateless stack reads: InvalidParameters must be empty
aws ssm get-parameters --query InvalidParameters --names \
  /umccr/certificate_arn /hosted_zone/umccr/id /hosted_zone/umccr/name \
  /data_portal/client/cog_user_pool_id /cognito/docs-app/app-client-id /orcaui/cog_app_client_id_stage

# In dev, the localhost client beta accepts as well
aws ssm get-parameters --query InvalidParameters --names /cognito/localhost-app/app-client-id

# b) The certificate is regional, issued, and covers sonar.<stage zone>
CERT=$(aws ssm get-parameter --name /umccr/certificate_arn --query Parameter.Value --output text)
aws acm describe-certificate --certificate-arn "$CERT" \
  --query 'Certificate.[Status, DomainName, join(`, `, SubjectAlternativeNames)]' --output text

# c) The CDK bootstrap trusts the toolchain account
aws cloudformation describe-stacks --stack-name CDKToolkit --output text \
  --query "Stacks[0].Parameters[?ParameterKey=='TrustedAccounts'].ParameterValue"

# d) First deploy of the stage only: the names are free
ZONE=$(aws ssm get-parameter --name /hosted_zone/umccr/name --query Parameter.Value --output text)
dig +short "sonar.$ZONE"                                                    # no answer
aws apigateway get-domain-names --query "items[?domainName=='sonar.$ZONE'].domainName"   # []
aws kms list-aliases --query "Aliases[?AliasName=='alias/orcasonar'].AliasName"           # []
aws bedrock list-guardrails --query "guardrails[?starts_with(name, 'orcasonar')].name"   # []
aws bedrock-agent list-knowledge-bases --query "knowledgeBaseSummaries[?starts_with(name, 'orcasonar')].name"   # []
```

| If                                                                               | Then                                                                              |
| -------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| a parameter is missing                                                           | step 1, or check you are in the right account                                     |
| the certificate does not cover `sonar.<stage zone>`, or is not in ap-southeast-2 | stop: the custom domain needs both                                                |
| `TrustedAccounts` does not include the toolchain account                         | bootstrap the account as `umccr/infrastructure` `scripts/aws_bootstrap` describes |
| a name is taken                                                                  | stop, and find out what owns it                                                   |

## Step 3: Try it in dev by hand (optional)

Deploying the beta stage stacks from a branch, with dev credentials, lets you check a change before it is merged. The
pipelines later take over the same stacks, under the same names.

```sh
cd orcasonar
corepack enable
make install
make check-all && make test-all   # lint, formatting, types; jest with cdk-nag, and the app's tests

aws sso login --profile dev && export AWS_PROFILE=dev AWS_REGION=ap-southeast-2
STATEFUL='OrcaSonarStatefulStack/DeploymentPipeline/Beta/OrcaSonarStatefulStack'     # UMCCR-OrcaSonarStatefulStack
STATELESS='OrcaSonarStatelessStack/DeploymentPipeline/Beta/OrcaSonarStatelessStack'   # UMCCR-OrcaSonarStatelessStack

pnpm cdk-stateful diff "$STATEFUL" --method template     # first deploy: every resource is new
pnpm cdk-stateful deploy "$STATEFUL"                     # review the IAM changes when asked, then answer y
pnpm cdk-stateless diff "$STATELESS" --method template
pnpm cdk-stateless deploy "$STATELESS"
```

Then run the checks in steps 4 and 5, and step 6 if docs.umccr.org's dev stage is ready.

## Step 4: The stateful pipeline

The toolchain stacks were deployed on 2026-10-13, so the `cdk deploy` commands in this step and the next are needed
again only for a new toolchain account or after a teardown. The checks still apply. Before deploying a pipeline:

- **The code is on `main`**: a pipeline builds `umccr/orcasonar` `main`, so an empty or older `main` fails, or
  deploys the wrong code.
- **GitHub access**: if the organisation's AWS Connector for GitHub app is installed for selected repositories only,
  an organisation owner adds `umccr/orcasonar` under **Settings → GitHub Apps → AWS Connector for GitHub →
  Configure**.

```sh
cd orcasonar
git switch main && git pull --ff-only
make install && make test

aws sso login --profile bastion-admin && export AWS_PROFILE=bastion-admin AWS_REGION=ap-southeast-2
pnpm cdk-stateful diff OrcaSonarStatefulStack --method template   # first deploy: every resource is new
pnpm cdk-stateful deploy OrcaSonarStatefulStack                   # review the IAM changes when asked, then answer y
```

The pipeline starts as soon as it exists ([diagram](design.md#deploying)). **PromoteToProd** waits 60 minutes, then
fails the run, so that an unanswered approval never holds back newer runs: until step 7, let it time out.

Watch it, with toolchain credentials:

```sh
aws codepipeline get-pipeline-state --name UMCCR-OrcaSonarStateful \
  --query 'stageStates[].[stageName, latestExecution.status]' --output table
```

When beta is deployed, check it with dev credentials:

```sh
aws ssm get-parameters-by-path --path /orcasonar --query 'Parameters[].Name'   # eight parameters
KB=$(aws ssm get-parameter --name /orcasonar/knowledge-base-id --query Parameter.Value --output text)
DS=$(aws ssm get-parameter --name /orcasonar/data-source-id --query Parameter.Value --output text)
aws bedrock-agent get-knowledge-base --knowledge-base-id "$KB" --query knowledgeBase.status    # ACTIVE
aws bedrock-agent get-data-source --knowledge-base-id "$KB" --data-source-id "$DS" --query dataSource.status   # AVAILABLE
aws bedrock get-guardrail --guardrail-identifier \
  "$(aws ssm get-parameter --name /orcasonar/guardrail-id --query Parameter.Value --output text)" \
  --query '[name, status, version]'
```

## Step 5: The stateless pipeline

Deploy it once the stateful pipeline has deployed beta: the stateless stack's deploy fails in a stage that has no
`/orcasonar/` parameters.

```sh
pnpm cdk-stateless diff OrcaSonarStatelessStack --method template
pnpm cdk-stateless deploy OrcaSonarStatelessStack
```

Its pipeline runs like the stateful one, with the app's checks and tests beside the infrastructure tests, and waits at
**PromoteToProd** in the same way. When beta is deployed, check it from anywhere:

```sh
API=https://sonar.dev.umccr.org/api/v1
curl -s "$API/health"                                  # {"status":"ok","version":"<commit>","stage":"beta"}
curl -s -o /dev/null -w '%{http_code}\n' -X POST "$API/search" \
  -H 'Content-Type: application/json' -d '{"query":"test"}'   # 401: every endpoint but /health needs a token
curl -s https://sonar.dev.umccr.org/schema/openapi.json | head -c 60; echo   # {"openapi":"3.1.0",…
curl -sI https://sonar.dev.umccr.org/schema/swagger-ui/ | grep -i '^content-type'   # text/html; charset=utf-8
curl -sI -X OPTIONS "$API/chat" -H 'Origin: https://docs.dev.umccr.org' \
  -H 'Access-Control-Request-Method: POST' | grep -i '^access-control-allow-origin'   # https://docs.dev.umccr.org
```

## Step 6: Connect docs.umccr.org

Nothing on the docs side needs a deploy: its hosting stack already allows the API in its Content Security Policy and
names it in `/_auth/env.js`, and its publish steps already look for `/orcasonar/ingest-bucket-name`.

### Documents

Each docs site's next release, once the stateful stack is in the stage, uploads its pages under `docs/<slug>/` in the
ingest bucket; an earlier release publishes the pages only, and warns that `/orcasonar/ingest-bucket-name` does not
exist. Every 15 minutes, if anything changed, one ingestion job indexes the documents. To fill the index straight
away, release each site once more: push a change under the site's docs paths, or
[start a release by hand](https://github.com/umccr/docs-platform/blob/main/docs/site/runbook.md#start-a-release-by-hand).
Then, with dev credentials:

```sh
BUCKET=$(aws ssm get-parameter --name /orcasonar/ingest-bucket-name --query Parameter.Value --output text)
aws s3 ls "s3://$BUCKET/docs/" --recursive --summarize | tail -2                # the documents and their metadata
KB=$(aws ssm get-parameter --name /orcasonar/knowledge-base-id --query Parameter.Value --output text)
DS=$(aws ssm get-parameter --name /orcasonar/data-source-id --query Parameter.Value --output text)
aws bedrock-agent start-ingestion-job --knowledge-base-id "$KB" --data-source-id "$DS"   # optional: not waiting
aws bedrock-agent list-ingestion-jobs --knowledge-base-id "$KB" --data-source-id "$DS" \
  --query 'ingestionJobSummaries[0].[ingestionJobId, status, statistics]'      # COMPLETE, within about 20 minutes
```

If the job fails, its reasons say why, for example the knowledge base role failing to read the KMS-encrypted
documents:

```sh
aws bedrock-agent get-ingestion-job --knowledge-base-id "$KB" --data-source-id "$DS" \
  --ingestion-job-id <ingestionJobId> --query 'ingestionJob.[status, failureReasons, statistics]'
```

### The chat

Open a page on `https://docs.dev.umccr.org/` signed in, open the chat panel, and ask something the docs answer. The
answer streams in, with its sources linking to docs pages, and a record lands under `records/` in the records bucket.

To call the API directly, take a token from the same signed-in page: in the browser's developer console, after
opening the chat panel, run `copy(await window.umccrDocsAuth.getIdToken())`. The token is the reader's for an hour;
never paste it anywhere but your terminal.

```sh
read -rs TOKEN   # paste the token; it is not echoed
curl -s "$API/search" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"query":"How do I add a site to docs.umccr.org?","topK":3}'
curl -N "$API/chat" -H "Authorization: Bearer $TOKEN" -H 'Accept: text/event-stream' \
  -H 'Content-Type: application/json' -d '{"query":"How do I add a site to docs.umccr.org?"}'
unset TOKEN
```

The stream is `meta`, then `delta` events, then `citations` and `done`, as [api.md](api.md) describes.

## Step 7: prod

1. **Prerequisites**: steps 1 and 2 in the prod account, including the docs platform's Cognito client in its
   `cognito_aai` workspace. On 2026-10-21 all were in place but two: the Claude model agreements
   ([model access](#model-access)), without which every answer fails, and someone to hear the [alerts](#alerts).
2. **Prod**: approve **PromoteToProd** on `UMCCR-OrcaSonarStateful` first, in the toolchain account's CodePipeline
   console, within 60 minutes of the run reaching it. Otherwise start the pipeline again, with toolchain credentials:

   ```sh
   aws codepipeline start-pipeline-execution --name UMCCR-OrcaSonarStateful
   ```

   Once its prod stage is done, approve the stateless pipeline's the same way (`UMCCR-OrcaSonarStateless`).

3. **Documents**: release each docs site once more, as in [step 6](#documents). Every earlier prod release skipped the
   export, so the index starts empty, and until its first ingestion job completes the chat says the documentation does
   not cover the question.
4. **Check** prod as in steps 4 to 6, with `https://sonar.prod.umccr.org/api/v1` and the prod docs hosts.

In prod, the stateful stack's KMS key, buckets and table are retained if the stack is deleted, and the table has
deletion protection.

## Later deploys

Merge to `main`; [the table above](#what-gets-deployed) says which pipeline starts. Both deploy beta, then wait for
**PromoteToProd**. When a change touches both stacks and the stateless one needs the stateful one's new resources,
approve the stateful pipeline's prod stage first. Changes that need care:

- **The knowledge base or its data source**: some property changes replace the knowledge base, and a replacement starts
  empty. The scheduler starts a job only after a document changes, so start one by hand after the deploy
  ([runbook](runbook.md#the-index-is-stale)). Check the stateful diff for replacements before approving prod.
- **A table index**: CloudFormation moves on without waiting for a new index, so approve the stateless pipeline's prod
  stage only once it is `ACTIVE`:
  `aws dynamodb describe-table --table-name OrcaSonarTable-prod --query 'Table.GlobalSecondaryIndexes[].[IndexName,IndexStatus]'`.
- **The guardrail** and **models**: follow the runbook ([guardrail](runbook.md#change-the-guardrail),
  [models](runbook.md#move-to-another-claude-model)).

## Verification checklist

Before calling a stage done:

- [ ] `GET /health` answers 200 without a token, with the deployed commit as `version`; every other endpoint under
      `/api/v1` answers 401 without one.
- [ ] `/schema/swagger-ui/` shows every endpoint in a browser, with no Content-Security-Policy errors in the console,
      and `/schema/openapi.json` answers JSON, to `curl` with and without `-H 'Accept: */*'`.
- [ ] A preflight from the stage's docs hosts gets `access-control-allow-origin`; one from any other origin does not.
- [ ] Documents appear under `docs/<slug>/` after a docs release, and an ingestion job completes within about 20
      minutes.
- [ ] The chat panel answers with sources. Before the first ingestion, when retrieval finds no passages, it says the
      documentation does not cover the question, without a model call.
- [ ] Each exchange writes a record under `records/date=YYYY-MM-DD/`; the logs hold the caller's `sub` and the
      outcome, never the question or the answer.
- [ ] Thumbs up or down on an answer writes under `feedback/`.
- [ ] `/api/v1/audit/exchanges` lists the answer with the reader's email for a member of the `admin` group, and
      answers `403` to anyone else.
- [ ] The alarms exist and are `OK`:
      `aws cloudwatch describe-alarms --alarm-name-prefix UMCCR-OrcaSonar --query 'MetricAlarms[].[AlarmName, StateValue]'`
      in the stage account.
- [ ] An alarm reaches the alerts topic's subscribers ([alerts](#alerts)), as it fires and as it returns to `OK` at
      its next evaluation:
      `aws cloudwatch set-alarm-state --alarm-name <one of them> --state-value ALARM --state-reason 'Checking alerts'`

## Troubleshooting

| Symptom                                                                                                                 | Likely cause                                                                                        | Fix                                                                                                     |
| ----------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| The stateless deploy fails: parameter `/orcasonar/...` not found                                                        | the stateful stack is not in that stage yet                                                         | wait for, or deploy, the stateful stack there; then run the stateless pipeline again                    |
| A deploy fails: parameter `/cognito/docs-app/app-client-id` not found                                                   | the docs platform's Cognito client is not applied to that workspace                                 | the docs-platform guide, step 1                                                                         |
| The beta deploy fails: parameter `/cognito/localhost-app/app-client-id` not found                                       | dev's `cognito_aai` workspace has no localhost client                                               | apply `cognito_aai` in dev, where `allow_cognito_app_local_map` turns it on                             |
| The custom domain fails: certificate                                                                                    | `/umccr/certificate_arn` is not in ap-southeast-2, or does not cover `sonar.<stage zone>`           | step 2                                                                                                  |
| The knowledge base fails to create                                                                                      | permissions for the managed vector store and the Sonar key                                          | the stack event's reason                                                                                |
| A stage stack is in `ROLLBACK_COMPLETE`                                                                                 | its first deploy failed and rolled back; CloudFormation cannot update it                            | delete the stack, fix the cause, and run the stage again                                                |
| A pipeline's first run fails at its source                                                                              | the AWS Connector app cannot read `umccr/orcasonar`, or `main` is empty                             | step 4                                                                                                  |
| `/chat` answers `unavailable`, with `AccessDeniedException` in the logs                                                 | model access, or the budget action attached `BudgetDenyPolicy` to the chat role                     | step 1; the [runbook](runbook.md#the-budget-ran-out)                                                    |
| `/chat` answers `unavailable`; the log's `detail` says "explicit deny in a service control policy"                      | the organisation's region policy refuses ap-southeast-4, where the `au.` profile sends some answers | [the region policy](#the-organisations-region-policy): an organisation administrator adds the exception |
| `/chat` answers `unavailable`; the log's `detail` says "not authorized to perform the required AWS Marketplace actions" | the account has not accepted the model's agreement                                                  | [model access](#model-access): an account administrator accepts it, once per model                      |
| `/chat` answers `unavailable`; the log's `detail` says "`temperature` is deprecated for this model"                     | a chat function built before 2026-10-15, which sends `temperature`                                  | deploy the stateless stack                                                                              |
| `/chat` answers `over-budget`                                                                                           | today's allowance is used                                                                           | the [runbook](runbook.md#the-budget-ran-out)                                                            |
| The browser blocks the chat with a CORS error                                                                           | the docs host is not in `DOCS_ORIGINS` for the stage                                                | `infrastructure/stage/config.ts`, in step with docs-platform's `DOCS_DOMAIN_NAMES`                      |
| Every call gets 401 with a fresh token                                                                                  | the token was issued to a client the authorizer does not allow, or by another stage's pool          | check the docs host and the stage match                                                                 |
| 403 from every call                                                                                                     | WAF blocked the address: the rate limit or a managed rule                                           | the web ACL's sampled requests in the console                                                           |
| Documents are uploaded but never searchable                                                                             | the ingestion scheduler is not running, or the job failed                                           | the [runbook](runbook.md#the-index-is-stale)                                                            |

## Teardown

Only to remove a deployment. In prod, the stateful stack retains the key, the buckets and the table, which also has
deletion protection; remove those by hand only after a deliberate decision.

1. **The toolchain stacks**, with toolchain credentials. This deletes the pipelines only; the stage stacks they
   deployed stay.

   ```sh
   pnpm cdk-stateless destroy OrcaSonarStatelessStack
   pnpm cdk-stateful destroy OrcaSonarStatefulStack
   ```

2. **A stage**, with that account's credentials, stateless first, because it uses the stateful stack's resources
   (`Prod` in the path for prod):

   ```sh
   pnpm cdk-stateless destroy 'OrcaSonarStatelessStack/DeploymentPipeline/Beta/OrcaSonarStatelessStack'
   pnpm cdk-stateful destroy 'OrcaSonarStatefulStack/DeploymentPipeline/Beta/OrcaSonarStatefulStack'
   ```

   Outside prod, the stateful stack deletes its buckets, so empty them first, every object version included:
   CloudFormation cannot delete a bucket that holds objects. The KMS key is scheduled for deletion, and its alias
   removed.

3. **The docs side**: nothing to do. Its publish steps skip the export once `/orcasonar/ingest-bucket-name` is gone,
   with a warning, and the chat panel reports that it cannot answer.
