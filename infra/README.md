# aws-prod infrastructure

Everything that stands the chatbot up on AWS for a test run and tears it
down again: CDK for AWS, Terraform for Cloudflare, a load generator, and
one operator command. The decision behind its shape is ADR 0014; this is
how to work it.

## Reading order

Start with the configuration; everything else follows from it.

| Read | What it tells you |
|---|---|
| `config/names.ts` | Every shared name (stacks, ports, tags, parameters), derived from the operator's `.env` |
| `config/steps.ts` | The five sizes aws-prod runs at, and what each one loads |
| `lib/worstCase.ts` | How a raise's worst-case cost is bounded by time |
| `bin/app.ts` | The three stacks and what they share |
| `lib/core/` | What stays while aws-prod is down |
| `lib/app/appStack.ts` | What stands up for a run, one construct per concern |
| `lib/load/` and `load/` | The generators' stack and the generator program |
| `cloudflare/core`, `cloudflare/app` | The origin identity, and the edge rules a raise adds |
| `scripts/commands/` | The commands, one script each, reading top to bottom; `scripts/aws-prod` lists them |
| `scripts/steps/`, `scripts/checks/` | What the commands run: steps named for the stack that raises them (`core-`, `app-`, `load-`), and checks before and after a raise |

## Before the first raise (by hand, once)

1. **Operator values, in the repository-root `.env`.** Three settings name
   everything aws-prod stands up, so nothing personal is committed:

   ```
   AWS_PROD_HOSTNAME=aws-prod.example.com   # public hostname, proxied by Cloudflare
   AWS_PROD_ZONE=example.com                # the Cloudflare zone it lives in
   AWS_PROD_PROJECT=aws-prod                # prefixes stacks, tags, buckets, parameters
   ```

   The two Cloudflare Terraform roots declare their variables in their
   `variables.tf` and take values from the scripts at run time (`-var`,
   zone id resolved through the API), fed by these same settings — there
   is no tfvars file to keep.
2. **AWS account.** A member account for aws-prod under AWS Organizations,
   with IAM Identity Center sign-in and a CLI profile named after the
   project (any other name works through `AWS_PROFILE`).
3. **Service quotas** in `ap-southeast-2`: Fargate On-Demand vCPUs (step100
   needs about 125), and anything else the first `step10` run reports.
4. **Cloudflare.** Any zone plan, Free included: the sign-in rate limit is
   off by default (`edge_rate_limit` in `cloudflare/app` says why), and the
   allow-list keeps everyone but the operator and the generators out. An
   API token in `CLOUDFLARE_API_TOKEN` that can edit DNS, SSL and
   certificates, WAF and configuration rules on that zone.
5. **Tools on the operator's machine:** AWS CLI v2 with the Session Manager
   plugin, Docker, Terraform 1.10+, Node 22+, jq, curl, openssl.
6. `npm ci` in this folder.

## Commands

```bash
scripts/aws-prod core          # once: bootstrap, core stack, origin identity
scripts/aws-prod seed          # once: create the synthetic population and snapshot it

scripts/aws-prod up smoke      # raise (about twenty minutes); run again to resume after a failure
scripts/aws-prod load          # one load run at the raised step, then a summary
scripts/aws-prod down          # tear down everything but core

scripts/aws-prod status        # what is up, and today's worst-case ledger
scripts/aws-prod sweep         # list anything that outlived its teardown
scripts/aws-prod db-tunnel     # the database on localhost:15433, through the bastion
```

`scripts/aws-prod <command> --help` shows a command's usage. Every command
also runs on its own as `scripts/commands/<command>.sh`.

A raise is refused when the day's recorded worst cases would pass $50, and
the safety net deletes the app stack three hours after a raise and the
load stack an hour after it starts, whether or not anyone remembers.

## Steps

Every step runs the API and the worker as separate services sharing
Valkey. `seed` creates the synthetic population once and snapshots the
database; every later step restores that snapshot.

## Checking changes without an account

```bash
npm run check                                    # typecheck, then synthesize every stack
terraform -chdir=cloudflare/core init -backend=false && terraform -chdir=cloudflare/core validate
terraform -chdir=cloudflare/app init -backend=false && terraform -chdir=cloudflare/app validate
```
