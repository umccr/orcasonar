# Deploying OrcaSonar

Every step to deploy OrcaSonar: the prerequisites in each stage account, the two pipelines in the toolchain account,
and connecting docs.umccr.org. Operating it afterwards is in the [runbook](runbook.md). docs.umccr.org is deployed
from `umccr/docs-platform`; its guide is
[docs/site/deploy.md](https://github.com/umccr/docs-platform/blob/main/docs/site/deploy.md) there.

> The commands below print account IDs, ARNs, bucket names and tokens. Keep them in your terminal or a private
> note: never paste them into this repository, a pull request or an issue.

## What gets deployed

| Piece                                                                                                                                                                                                                                                      | Source                                            | Account          | Deployed by                                                                        |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- | ---------------- | ---------------------------------------------------------------------------------- |
| Toolchain stack `OrcaSonarStatefulStack`: pipeline `UMCCR-OrcaSonarStateful`                                                                                                                                                                               | `infrastructure/toolchain/stateful-stack.ts`      | toolchain        | `pnpm cdk-stateful deploy` once, by hand; after that, the pipeline updates itself  |
| Toolchain stack `OrcaSonarStatelessStack`: pipeline `UMCCR-OrcaSonarStateless`                                                                                                                                                                             | `infrastructure/toolchain/stateless-stack.ts`     | toolchain        | `pnpm cdk-stateless deploy` once, by hand; after that, the pipeline updates itself |
| Stateful stage stack: the Sonar KMS key (`alias/orcasonar`), the ingest and records buckets, table `OrcaSonarTable-<stage>`, knowledge base `orcasonar-<stage>` with data source `docs`, guardrail `orcasonar-<stage>`, SSM parameters under `/orcasonar/` | `infrastructure/stage/stateful-stack.ts`          | dev (beta), prod | the stateful pipeline; beta can also be deployed by hand                           |
| Stateless stage stack: the API at `sonar.<stage zone>` with WAF and the authorizer, the chat and query functions, ingestion scheduling, budget `orcasonar-bedrock-<stage>` with its action, alarms and the alerts topic, SSM `/orcasonar/api-url`          | `infrastructure/stage/stateless-stack.ts`, `app/` | dev (beta), prod | the stateless pipeline; beta can also be deployed by hand                          |

The stage stacks are CloudFormation stacks `UMCCR-OrcaSonarStatefulStack` and `UMCCR-OrcaSonarStatelessStack`,
the same names in every stage account, tagged `umccr-org:Product: OrcaSonar`. `cdk deploy` selects them by construct
path, such as `OrcaSonarStatefulStack/DeploymentPipeline/<Stage>/OrcaSonarStatefulStack`, with `<Stage>` either
`Beta` (dev) or `Prod`, which also name the pipelines' stages; the stg account runs no OrcaSonar stage. Both pipelines are built by
`infrastructure/toolchain/deployment-pipeline.ts`, the construct docs.umccr.org's pipeline uses too, adapted from the
OrcaBus one so that nothing is named for OrcaBus. The stateless stack reads the stateful stack's resources from the SSM parameters it writes, so **in every account the
stateful stack deploys first**.

Each pipeline builds `umccr/orcasonar` `main`, runs the tests, deploys beta, then waits at **PromoteToProd**, the
first action of its prod stage, for approval. Changes start one pipeline or both:

| A change to                                                                                             | Starts                 |
| ------------------------------------------------------------------------------------------------------- | ---------------------- |
| `app/`                                                                                                  | the stateless pipeline |
| `infrastructure/stage/stateful-stack.ts`, `infrastructure/toolchain/stateful-stack.ts`                  | the stateful pipeline  |
| `infrastructure/stage/stateless-stack.ts`, `infrastructure/toolchain/stateless-stack.ts`                | the stateless pipeline |
| anything else, such as `infrastructure/stage/config.ts`, `constants.ts`, `package.json` or the lockfile | both                   |
| `docs/`, or Markdown anywhere                                                                           | neither                |

## State on 2026-10-21

A read-only check of the toolchain, dev and prod accounts, which changed nothing, found:

|                 | Toolchain account                                                                                                                                                                                                                                                                                                                                                                                        | dev account                                                                                                                                                                                                                                                                                                                                                                                                     | prod account                                                                                                                                                                                                                                       |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Prerequisites   | all present: `codestar_github_arn` (connection `AVAILABLE`), `/chatbot_arn/slack/alerts-build`, CDK bootstrap version 32                                                                                                                                                                                                                                                                                 | all present: `/umccr/certificate_arn` (regional, covering `*.dev.umccr.org`), `/hosted_zone/umccr/*`, `/data_portal/client/cog_user_pool_id`, `/cognito/docs-app/app-client-id`; CDK bootstrap version 32, trusting the toolchain account; API Gateway's CloudWatch role                                                                                                                                        | all present, as in dev, with the certificate covering `*.prod.umccr.org`; none of OrcaSonar's names is taken                                                                                                                                       |
| Models          |                                                                                                                                                                                                                                                                                                                                                                                                          | `au.anthropic.claude-sonnet-5` and `au.anthropic.claude-haiku-4-5-20251001-v1:0` active, routing to ap-southeast-2 and ap-southeast-4. Anthropic's use-case form submitted and both models' agreements accepted on 2026-10-15 ([model access](#model-access)); the organisation's region policy allows ap-southeast-4 since the same day ([region policy](#the-organisations-region-policy))                    | both profiles active, but **neither model's agreement accepted** (`agreementAvailability` `NOT_AVAILABLE`): until an administrator accepts them ([model access](#model-access)), every answer fails                                                |
| OrcaSonar       | the toolchain stacks are deployed (2026-10-13), and `cdk diff --method template` against the branch is clean for both, so the first run's self-update changes nothing. `main` on GitHub holds only an empty initial commit, so both pipelines fail at Build, which has no code to test. Merging the branch starts both; its head passes the same build steps (Node.js 24, `--ignore-scripts`, no `.git`) | both stage stacks deployed by hand from the branch (step 3), last on 2026-10-16. Against the branch head, `cdk diff --method template` changes only the stateful stack's commit output, and adds the stateless stack's alarms, access logs and WAF count overrides, replacing nothing but the API deployment. The knowledge base holds both sites' documents, from the docs site pipeline, and the chat answers | nothing deployed. The docs platform's `docs-publisher` role there already has its grants on the ingest bucket, but every prod release so far skipped the export, since `/orcasonar/ingest-bucket-name` does not exist yet ([step 7](#step-7-prod)) |
| Still to decide |                                                                                                                                                                                                                                                                                                                                                                                                          | Bedrock's data-retention mode was `inherit`, not `none`, on 2026-10-12 (step 1)                                                                                                                                                                                                                                                                                                                                 | who hears the [alerts](#alerts)                                                                                                                                                                                                                    |

stg runs no OrcaSonar stage, and held no OrcaSonar resources on 2026-10-21.

## Before you start

**Access:**

| For                                                                        | You need                                                                                                   |
| -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Model access, checks, by-hand deploys to a stage                           | admin on the stage account through AWS SSO                                                                 |
| Accepting the Claude model agreements (manual, once per account and model) | an admin of the stage account who may subscribe in AWS Marketplace, and may accept licence terms for UMCCR |
| Anthropic's use-case form (manual, once)                                   | an organisation administrator, in the management account; or an admin of each stage account                |
| The toolchain stacks and pipelines                                         | admin on the toolchain (bastion) account                                                                   |
| The data-retention setting and its SCP                                     | an AWS organisation administrator                                                                          |
| The AWS Connector app's repository access                                  | an owner of the umccr GitHub organisation                                                                  |

The examples use the SSO profiles `bastion-admin` for the toolchain account and `dev` for the dev account; use
yours if they are named differently, and the prod profile for prod.

```sh
aws sso login --profile bastion-admin && export AWS_PROFILE=bastion-admin   # the toolchain account
aws sso login --profile dev && export AWS_PROFILE=dev                       # a stage account
export AWS_REGION=ap-southeast-2
aws sts get-caller-identity --query Account --output text                   # check it is the account you expect
```

**Tools:** the AWS CLI v2, Node.js 24 or later, pnpm 10.34.5 through Corepack (`corepack enable`),
[pre-commit](https://pre-commit.com), whose git hook `make install` installs, `git`, `curl` and `dig`.

## Order

```text
1. Prerequisites in each stage account: the Claude model agreements (manual), data retention, the docs platform's
   Cognito client
2. Pre-flight checks, read-only: the toolchain account and each stage account
3. dev, optional: deploy both stage stacks by hand from the branch, and try them
4. Push main, then deploy the stateful pipeline; wait until it has deployed beta
5. Deploy the stateless pipeline
6. Connect docs.umccr.org: documents, then the chat
7. prod: steps 1 and 2 there, then PromoteToProd on the stateful pipeline, then on the stateless one; then release
   each docs site once more, so prod's index gets its documents
```

---

## Step 1: Prerequisites in each stage account

### Model access

The answers come from Claude Sonnet 5 through the Australian cross-Region inference profile, and Claude Haiku 4.5 is
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

#### Why each model needs an agreement

Claude models on Bedrock are third-party models, sold through AWS Marketplace. Before an account can call one, it
needs:

1. **Anthropic's use-case form**, filled in once ("first-time use"): who the account belongs to and what the models
   are for.
2. **A Marketplace agreement for each model.** Creating it accepts the model's licence terms
   ([Serverless Third-Party Model License Agreements](https://aws.amazon.com/legal/bedrock/third-party-models/)) and
   starts pay-per-use billing, which appears on the AWS bill as Marketplace charges. Nothing is charged until the
   model is called.
3. **A payment method for Marketplace purchases.** In UMCCR's organisation, the management account's consolidated
   billing provides it.

Bedrock usually creates the agreement by itself the first time a model is called, but only when the caller may
subscribe in Marketplace (`aws-marketplace:Subscribe`, `aws-marketplace:Unsubscribe` and
`aws-marketplace:ViewSubscriptions`). The chat role deliberately has none of these: a service role should not be
able to accept licence terms or start new billing on the account's behalf. So until an administrator accepts, the
chat function's first call fails, and so does every call after it: `agreementAvailability` stays `NOT_AVAILABLE`,
and the log says the role "is not authorized to perform the required AWS Marketplace actions". Once an agreement
exists, the chat role calls the model with its own permissions and needs no Marketplace permission at all.

Accepting is the account owner's decision, because it agrees to the licence terms for UMCCR. Read the terms first:
`list-foundation-model-agreement-offers` below prints a link to them.

What an agreement covers:

| Scope             | Covered?                                                                                                                                                                                                                            |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The account       | yes, that account only. dev and prod each accept for themselves                                                                                                                                                                     |
| The model         | that model only. Claude Sonnet 5 and Claude Haiku 4.5, which `config.ts` uses, need one each. Claude Sonnet 5.5 and Claude Haiku 5.5 have active `au.` profiles too, and need their own agreements before `config.ts` moves to them |
| The Region        | every Region where the model is offered, so Sydney and Melbourne alike                                                                                                                                                              |
| The use-case form | every Anthropic model, once per account. Submitted in the organisation's management account, it covers every member account. Melbourne is an opt-in Region, where AWS may ask for the form again                                    |

In dev on 2026-10-15, the use-case form had not been submitted, and no Claude model had an agreement, in either
Region.

#### Why it is not in the CDK app

The stacks cannot accept the agreements for you, so this is a manual step:

- **CloudFormation has nothing to declare.** It has no resource for a model agreement, Anthropic's use-case form or
  a Marketplace subscription, so neither has the CDK. Checked on 2026-10-15: no such `AWS::Bedrock::` type in the
  registry, and nothing in aws-cdk-lib 2.273.
- **A custom resource could, but should not.** A deploy-time function could call the same APIs, but it would need
  permission to subscribe in Marketplace, and every deploy to a new account would accept licence terms and start
  billing for UMCCR without anyone deciding to. AWS advises organisations that review licences to do the opposite:
  keep model use blocked until someone has read and accepted the terms.

The stacks deploy without the agreements, and search works; only answers fail until they exist. Accept them once per
account and model: before a stage's first answer, and before `config.ts` moves to a model the stage has not accepted
(see the [runbook](runbook.md#move-to-another-claude-model)).

#### Accepting: the manual steps

**Who:** an administrator of the stage account who may subscribe in AWS Marketplace (`AdministratorAccess` includes
the three permissions above), and who may accept licence terms for UMCCR, or has the go-ahead from whoever may.

1. **Check what is missing**: run the check at the top of this section, then check for the use-case form.

   ```sh
   export AWS_PROFILE=<the stage's admin profile> AWS_REGION=ap-southeast-2
   aws bedrock get-use-case-for-model-access --query 'length(formData)'   # ResourceNotFoundException: not submitted
   ```

2. **Submit Anthropic's use-case form, once.** It is best done in the organisation's management account, by an
   organisation administrator, because every member account inherits it; otherwise, do it in each stage account. In
   the console, the form appears when you first open an Anthropic model in the Bedrock model catalog. With the CLI:

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

   Or in the console: open the model in the Bedrock model catalog in ap-southeast-2, and send one short message from
   the playground. That first call, by someone who may subscribe, creates the agreement.

5. **Check again**: the check at the top of this section should show `AVAILABLE` in both Regions.
   - Right after the use-case form, an agreement can stay `PENDING` for a while, and AWS emails when it is ready.
   - Melbourne is an opt-in Region, where AWS may ask for the form again. If `agreementAvailability` stays
     `NOT_AVAILABLE` there, repeat step 2 with `--region ap-southeast-4`.

6. **Ask a question** in the chat panel. Nothing needs redeploying: the next question gets an answer, and CloudTrail
   shows `ConverseStream` without an error.

   ```sh
   aws cloudtrail lookup-events --lookup-attributes AttributeKey=EventName,AttributeValue=ConverseStream \
     --max-results 5 --query 'Events[].CloudTrailEvent' --output text | grep -o '"errorCode":"[^"]*"' || echo "no errors"
   ```

7. **Record it** in the table below.

| Stage | Use-case form                                    | Claude Sonnet 5       | Claude Haiku 4.5      |
| ----- | ------------------------------------------------ | --------------------- | --------------------- |
| dev   | submitted in both Regions (2026-10-15)           | accepted (2026-10-15) | accepted (2026-10-15) |
| prod  | inherited if the management account submitted it | to do                 | to do                 |

To stop the account using a model later, deny it in IAM or with a service control policy. Deleting the agreement
(`aws bedrock delete-foundation-model-agreement`) is not enough, because the next call by someone who may subscribe
creates it again.

### The organisation's region policy

The `au.` profiles send each request to Sydney (ap-southeast-2) or Melbourne (ap-southeast-4). Neither model can be
called in Sydney alone, so a service control policy that denies ap-southeast-4 refuses the answers: `/chat` answers
`unavailable`, and the chat function's log shows `AccessDeniedException` with "an explicit deny in a service control
policy".

UMCCR's organisation policy is a list of approved regions. Until 2026-10-15 it held Sydney only, and every answer in
dev failed that way. Since 2026-10-15 it holds Sydney and Melbourne, for every service. Checked in dev that day:
calls in Melbourne succeed, calls outside Australia are still denied by the policy, and the policy simulator allows
the chat role's model call in both regions and denies it elsewhere:

```sh
aws ec2 describe-availability-zones --region ap-southeast-4 --query 'AvailabilityZones[0].ZoneName'   # allowed
aws ec2 describe-availability-zones --region ap-southeast-1   # "explicit deny in a service control policy"
```

If the organisation ever narrows the list to Sydney again, the exception AWS describes for
[cross-Region inference in multi-account environments](https://aws.amazon.com/blogs/machine-learning/enable-amazon-bedrock-cross-region-inference-in-multi-account-environments/)
lets the Australian profiles through while the rest of Melbourne stays denied:

```json
"ArnNotLike": { "bedrock:InferenceProfileArn": "arn:aws:bedrock:*:*:inference-profile/au.*" }
```

Search works either way: only answers need the model.

To see whether a policy is refusing answers, with that account's credentials:

```sh
aws cloudtrail lookup-events --lookup-attributes AttributeKey=EventName,AttributeValue=ConverseStream \
  --max-results 10 --query 'Events[].CloudTrailEvent' --output text | grep -o '"errorMessage":"[^"]*"'
```

### Data retention

OrcaSonar is designed for an account that keeps no prompts or answers at Bedrock: data-retention mode `none` in
ap-southeast-2, with an SCP that stops anyone changing it, so a model that requires retention refuses to run instead
of quietly retaining. An organisation administrator decides and sets both; nothing in this repository changes it.

```sh
aws bedrock get-account-data-retention   # mode: none is the design; inherit is what dev has today
```

### Parameters from other repositories

| Parameter                                          | Written by                                         | Used for                                                                                |
| -------------------------------------------------- | -------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `/umccr/certificate_arn`                           | the account's shared setup                         | the API's custom domain: a certificate in ap-southeast-2 covering `sonar.<stage zone>`  |
| `/hosted_zone/umccr/id`, `/hosted_zone/umccr/name` | the account's shared setup                         | the `sonar` DNS record                                                                  |
| `/data_portal/client/cog_user_pool_id`             | `umccr/infrastructure` `cognito_aai`               | the authorizer's user pool                                                              |
| `/cognito/docs-app/app-client-id`                  | `umccr/infrastructure` `cognito_aai/app_docs.tf`   | the authorizer's allowed client: apply it as the docs-platform guide's step 1 describes |
| `/orcaui/cog_app_client_id_stage`                  | `umccr/infrastructure` `cognito_aai/app_orcaui.tf` | the authorizer's allowed client for OrcaUI; already there wherever OrcaUI runs          |

### API Gateway logging (optional)

Access and execution logs need API Gateway's account-level CloudWatch role, which other stacks in the account may
already set:

```sh
aws apigateway get-account --query cloudwatchRoleArn --output text   # None: not set
```

If it is set, the stage's entry in `ACCESS_LOGS` (`infrastructure/stage/config.ts`) can turn the access logs on;
without the role, the stage's deploy fails. Both stages have the role and their access logs on (checked
2026-10-21).

### Alerts

Every alarm, and the budget's notices, go to one SNS topic in each stage: the stateless stack's `AlertsTopicArn`
output. Nobody hears them until someone subscribes, so before prod do one of these:

- **Email**: add a team address, rather than a person's, to the stage's `ALERT_EMAILS` in
  `infrastructure/stage/config.ts`. After the deploy, the address receives a request to confirm the subscription,
  and hears nothing until someone confirms it.
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

Deploying the beta stage stacks straight from the branch, with dev credentials, lets you check the open items in
[architecture.md](architecture.md#open-items) before anything is merged. The pipelines later take over the same
stacks, under the same names.

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

**Both pipelines' stacks are deployed already (2026-10-13; see [State](#state-on-2026-10-21)).** They fail at
Build until the code is on `main`, whose only commit on GitHub is empty, and merging it starts both, so the
`cdk deploy` commands in this step and the next are needed again only for a new toolchain account or after a
teardown. The checks below still apply.

The pipelines build `umccr/orcasonar` `main`. Before deploying them:

- **Push `main`**: the reviewed code must be on `main`. A pipeline deployed earlier builds an empty or older `main`
  and fails, or deploys the wrong code.
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

The pipeline starts as soon as it exists:

```text
Source (main) ─▶ unit tests (pnpm test) ─▶ synth ─▶ self-update ─▶ assets
  ─▶ Beta: UMCCR-OrcaSonarStatefulStack in dev
  ─▶ Prod: PromoteToProd (approval), then UMCCR-OrcaSonarStatefulStack in prod
```

**PromoteToProd** waits 60 minutes, then fails the run, so that an unanswered approval never holds back newer runs.
Until step 7, let it time out: that is harmless, and every run asks again.

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

Once the stateful pipeline has deployed beta: the stateless stack's deploy in a stage fails while that stage has no
`/orcasonar/` parameters.

```sh
pnpm cdk-stateless diff OrcaSonarStatelessStack --method template
pnpm cdk-stateless deploy OrcaSonarStatelessStack
```

Its pipeline runs like the stateful one, with the app's checks and tests (`cd app && pnpm check && pnpm test`)
beside the infrastructure tests, and waits at **PromoteToProd** in the same way.

When beta is deployed, check it from anywhere:

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

With dev credentials, the stack wrote `/orcasonar/api-url`:

```sh
aws ssm get-parameter --name /orcasonar/api-url --query Parameter.Value --output text
```

## Step 6: Connect docs.umccr.org

Nothing on the docs side needs a deploy: its hosting stack already allows the API in its Content Security Policy and
names it in `/_auth/env.js`, and its publish steps already look for `/orcasonar/ingest-bucket-name`.

### Documents

Each docs site's next release, after the stateful stack is in the stage, uploads its pages under `docs/<slug>/` in
the ingest bucket. A release before that publishes the pages only, and its log warns that
`/orcasonar/ingest-bucket-name` does not exist. Every 15 minutes, if anything changed, one ingestion job indexes the
documents. To fill the index straight away, release each site once more: push a change under the site's docs paths,
or start a release by hand
([docs-platform runbook](https://github.com/umccr/docs-platform/blob/main/docs/site/runbook.md#start-a-release-by-hand)).
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
answer streams in, with its sources linking to docs pages. Answers record to `records/` in the records bucket.

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
2. **Prod**: approve **PromoteToProd** on `UMCCR-OrcaSonarStateful` first, the first action of its prod stage, in the
   toolchain account's CodePipeline console, within 60 minutes of the run reaching it. Otherwise start the pipeline
   again, with toolchain credentials:

   ```sh
   aws codepipeline start-pipeline-execution --name UMCCR-OrcaSonarStateful
   ```

   Once its prod stage is done, approve the stateless pipeline's the same way (`UMCCR-OrcaSonarStateless`).

3. **Documents**: release each docs site once more, as in [step 6](#documents), once the stateful stack is in prod.
   Every earlier prod release skipped the export, so the index starts empty, and until its first ingestion job
   completes, the chat says the documentation does not cover the question.
4. **Check** prod as in steps 4 to 6, with `https://sonar.prod.umccr.org/api/v1` and the prod docs hosts.

In prod, the stateful stack's KMS key, buckets and table are retained if the stack is deleted, and the table has
deletion protection.

## Later deploys

Merge to `main`; the table under [What gets deployed](#what-gets-deployed) says which pipeline starts. Both deploy
beta, then wait for **PromoteToProd**. When a change touches both stacks and the stateless one needs the
stateful one's new resources, approve the stateful pipeline's prod stage first.

Changes that need care:

- **The knowledge base or its data source**: some property changes replace the knowledge base, and a replacement
  starts empty. The scheduler only starts a job after a document changes, so start one by hand after the deploy
  (the [runbook](runbook.md#the-index-is-stale)). Check the stateful diff for replacements before approving prod.
- **The guardrail**: each change to its policies publishes a new version. The stateless stack reads
  `/orcasonar/guardrail-version` when it deploys, and a guardrail change starts only the stateful pipeline, so start
  the stateless pipeline once the stateful one has deployed the change.
- **Models**: change `ANSWER_MODEL_ID` and `ALLOWED_MODEL_IDS` together with the prices in
  `app/src/services/pricing.ts`, which the budget counts with, after checking model access (step 1) in every
  account.

## Verification checklist

Before calling a stage done:

- [ ] `GET /health` answers 200 without a token, with the deployed commit as `version`; every other endpoint under
      `/api/v1` answers 401 without one.
- [ ] `/schema/swagger-ui/` shows every endpoint in a browser, with no Content-Security-Policy errors in the console,
      and `/schema/openapi.json` answers JSON, to `curl` with and without `-H 'Accept: */*'`.
- [ ] A preflight from the stage's docs hosts gets `access-control-allow-origin`; one from any other origin does not.
- [ ] Documents appear under `docs/<slug>/` after a docs release, and an ingestion job completes within about 20
      minutes.
- [ ] The chat panel answers with sources. Before the first ingestion, when retrieval finds no passages, it says
      the documentation does not cover the question, without a model call.
- [ ] Each exchange writes a record under `records/date=YYYY-MM-DD/`; the logs hold the caller's `sub` and the
      outcome, never the question or the answer.
- [ ] Thumbs up or down on an answer writes under `feedback/`.
- [ ] `/api/v1/audit/exchanges` lists the answer with the reader's email for a member of the `admin` group, and
      answers `403` to anyone else.
- [ ] The alarms exist and are `OK`:
      `aws cloudwatch describe-alarms --alarm-name-prefix UMCCR-OrcaSonar --query 'MetricAlarms[].[AlarmName, StateValue]'`
      in the stage account.
- [ ] An alarm reaches the alerts topic's subscribers ([Alerts](#alerts)), as it fires and as it returns to `OK` at
      its next evaluation:
      `aws cloudwatch set-alarm-state --alarm-name <one of them> --state-value ALARM --state-reason 'Checking alerts'`

## Troubleshooting

| Symptom                                                                                                                             | Likely cause                                                                                        | Fix                                                                                          |
| ----------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| The stateless deploy fails: parameter `/orcasonar/...` not found                                                                    | the stateful stack is not in that stage yet                                                         | wait for, or deploy, the stateful stack there; then run the stateless pipeline again         |
| A deploy fails: parameter `/cognito/docs-app/app-client-id` not found                                                               | the docs platform's Cognito client is not applied to that workspace                                 | docs-platform guide, step 1                                                                  |
| The custom domain fails: certificate                                                                                                | `/umccr/certificate_arn` is not in ap-southeast-2, or does not cover `sonar.<stage zone>`           | step 2                                                                                       |
| The knowledge base fails to create                                                                                                  | permissions for the managed vector store and the Sonar key                                          | the stack event's reason; an open item in [architecture.md](architecture.md#open-items)      |
| A stage stack is in `ROLLBACK_COMPLETE`                                                                                             | its first deploy failed and rolled back; CloudFormation cannot update it                            | delete the stack, fix the cause, and run the stage again                                     |
| A pipeline's first run fails at its source                                                                                          | the AWS Connector app cannot read `umccr/orcasonar`, or `main` is empty                             | step 4                                                                                       |
| `/chat` answers `unavailable`, with `AccessDeniedException` in the logs                                                             | model access, or the budget action attached `BudgetDenyPolicy` to the chat role                     | step 1; the [runbook](runbook.md#the-budget-ran-out)                                         |
| `/chat` answers `unavailable`; the log's `detail` says "explicit deny in a service control policy"                                  | the organisation's region policy refuses ap-southeast-4, where the `au.` profile sends some answers | [step 1](#the-organisations-region-policy): an organisation administrator adds the exception |
| `/chat` answers `unavailable`; the log's `detail` says the role is "not authorized to perform the required AWS Marketplace actions" | the account has not accepted the model's agreement (`agreementAvailability` `NOT_AVAILABLE`)        | [step 1](#model-access): an account administrator accepts it, once per model                 |
| `/chat` answers `unavailable`; the log's `detail` says "`temperature` is deprecated for this model"                                 | a chat function built before 2026-10-15, which sends `temperature`; Claude Sonnet 5 refuses it      | deploy the stateless stack                                                                   |
| `/chat` answers `over-budget`                                                                                                       | today's allowance is used                                                                           | the [runbook](runbook.md#the-budget-ran-out)                                                 |
| The browser blocks the chat with a CORS error                                                                                       | the docs host is not in `DOCS_ORIGINS` for the stage                                                | `infrastructure/stage/config.ts`, in step with docs-platform's `DOCS_DOMAIN_NAMES`           |
| Every call gets 401 with a fresh token                                                                                              | the token was issued to a client the authorizer does not allow, or by another stage's pool          | check the docs host and the stage match                                                      |
| 403 from every call                                                                                                                 | WAF blocked the address: the rate limit or a managed rule                                           | the web ACL's sampled requests in the console                                                |
| Documents are uploaded but never searchable                                                                                         | the ingestion scheduler is not running, or the job failed                                           | the [runbook](runbook.md#the-index-is-stale)                                                 |

## Teardown

Only to remove a deployment. In prod, the stateful stack retains the key, the buckets and the table, which also has
deletion protection; remove those by hand only after a deliberate decision.

1. **The toolchain stacks**, with toolchain credentials:

   ```sh
   pnpm cdk-stateless destroy OrcaSonarStatelessStack
   pnpm cdk-stateful destroy OrcaSonarStatefulStack
   ```

   This deletes the pipelines only; the stage stacks they deployed stay.

2. **A stage**, with that account's credentials, stateless first, because it uses the stateful stack's resources:

   ```sh
   pnpm cdk-stateless destroy 'OrcaSonarStatelessStack/DeploymentPipeline/Beta/OrcaSonarStatelessStack'
   pnpm cdk-stateful destroy 'OrcaSonarStatefulStack/DeploymentPipeline/Beta/OrcaSonarStatefulStack'
   ```

   (`Prod` in the path for prod.) Outside prod, the stateful stack deletes its buckets, so empty them first, every object
   version included: CloudFormation cannot delete a bucket that holds objects. The KMS key is scheduled for
   deletion, and its alias is removed.

3. **The docs side**: nothing to do. Its publish steps skip the export once `/orcasonar/ingest-bucket-name` is gone,
   with a warning, and the chat panel reports that it cannot answer.
