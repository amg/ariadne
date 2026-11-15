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
| `bin/app.ts` | The four stacks and what they share |
| `lib/core/` | What stays while aws-prod is down |
| `lib/app/appStack.ts` | What stands up for a run, one construct per concern |
| `lib/edgeRules/` | The edge's web ACL, raised with the app in `us-east-1` |
| `lib/load/` | The generators' stack |
| `../load/` | The load harness: the generator program, the archive and the rebuild that gives a run its verdict, a workspace held to the app's standard |
| `cloudflare/core`, `cloudflare/app` | The hostname's certificate, and the DNS record a raise points at the distribution |
| `scripts/commands/` | The commands, one script each, reading top to bottom; `scripts/aws-prod` lists them |
| `scripts/steps/`, `scripts/checks/` | What the commands run: steps named for the stack that raises them (`core-`, `app-`, `load-`), and checks before and after a raise |

## Before the first raise (by hand, once)

1. **Operator values, in the repository-root `.env`.** Three settings name
   everything aws-prod stands up, so nothing personal is committed:

   ```
   AWS_PROD_HOSTNAME=aws-prod.example.com   # public hostname, served by CloudFront
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
3. **Service quotas** in `ap-southeast-2`: Fargate On-Demand vCPUs for the app
   and Fargate Spot vCPUs for the load generators. `up` refuses a step that
   does not fit either quota before anything is created, and says which
   quota and by how much. The operator needs `servicequotas:GetServiceQuota`.
   A load step replaces its tasks in a deploy, so a deploy takes no vCPU
   beyond the step's own; step-prod keeps its capacity and counts the extra
   tasks.
4. **Cloudflare, for DNS only.** Any zone plan, Free included: Cloudflare
   only answers for the hostname, and CloudFront does everything else. An
   API token in `CLOUDFLARE_API_TOKEN` that can read that zone and edit its
   DNS.
5. **Tools on the operator's machine:** AWS CLI v2 with the Session Manager
   plugin, Docker, Terraform 1.10+, Node 22+, jq, curl, openssl.
6. `npm ci` in this folder, and at the repository root, where the harness the archive runs on lives.

## Commands

```bash
scripts/aws-prod core          # once: bootstrap in both regions, core stack, the hostname's certificate
scripts/aws-prod seed          # once: create the synthetic population and snapshot it
scripts/aws-prod snapshot      # replace the seed snapshot with the database that is up

scripts/aws-prod up smoke      # raise (about twenty minutes); run again to resume after a failure
scripts/aws-prod up scale10    # rehearse production's scaling: services start at their floors, and a load rises, holds and falls
scripts/aws-prod up step-prod  # raise production configuration with auto-scaling (no load generator).
scripts/aws-prod load-image    # build the generators' image alone; the next run's generators use it, with no new raise
scripts/aws-prod load          # one load run at the raised step, through CloudFront as users reach it, then archive it into load/.runs/ and rebuild its verdict
scripts/aws-prod down          # tear down everything but core; refused while a run is unsealed
scripts/aws-prod down --force  # the same, whether or not every run is sealed

scripts/aws-prod archive <run id>  # seal a run that `load` could not, or resume its archive
scripts/aws-prod rebuild <run id>  # write a sealed run's verdict and report again; a run id may be given by its timestamp alone, such as 20261020T090836Z

scripts/aws-prod status        # what is up, and today's worst-case ledger
scripts/aws-prod sweep         # list anything that outlived its teardown
scripts/aws-prod db-tunnel     # the database on localhost:15433, through the bastion
scripts/aws-prod ecs-status    # show ECS services and their current/desired task counts.
scripts/aws-prod ecs-stop      # scale all ECS services to 0 tasks (stop compute, keep DB running).
scripts/aws-prod ecs-start     # scale ECS services back to their step's desired task counts.
scripts/aws-prod monitor       # users online, chat first byte, tasks per service and the load, a row a minute, highlighted against the pass lines.
scripts/aws-prod reset-budget  # clear today's worst-case ledger by hand
```

`scripts/aws-prod <command> --help` shows a command's usage. Every command
also runs on its own as `scripts/commands/<command>.sh`.

A raise is refused when the day's recorded worst cases would pass $100. A
load run that does not run its whole plan, because it was interrupted or
failed, stops counting toward that limit; the ledger still lists it, since it
may have cost something. `reset-budget` clears the day by hand. And
the safety net deletes the app stack and its edge rules four hours
after a raise and the load stack 150 minutes after it starts, whether or not
anyone remembers.

## Runs

A growing load balancer cuts open push streams. So step10, step50 and step100 first run an unrecorded warm-up under `<run id>-warm-up`, which grows the load balancer before the measured run. Its requests stay out of the run's folder. When it does not finish, the run does not begin.

A run's users arrive over its ramp and stay through its hold. A step with a fall then lets them go one at a time over it, the last to arrive the first to leave; any other step lets them all go at once. Only the hold is judged against the pass criteria, and a push stream closed by a user who left is not one that ended early. When the step's services scale, the archive keeps watching for half an hour after the run, instead of five minutes, and the verdict fails a run whose scaling services are not back at their floors by then.

Every load run is archived into its folder on the operator's machine, `load/.runs/<run id>/`, before `load` returns: the generators' request lines, the API's, worker's and auth's logs, every CloudWatch metric of the raise, the database's Performance Insights, and what ECS and scaling recorded. The load balancer's access logs stay where it writes them, under the vault's `origin-access-logs/`. A run is sealed when its folder holds its manifest, written last; one that has begun and has no manifest is unsealed, and `down` refuses while the raise has one. The vault keeps no runs: runs from before this (under the vault's `runs/`) can be deleted with `aws s3 rm s3://<vault bucket>/runs/ --recursive`.

Log groups outlive their stack for a month, so a teardown never takes them before the archive has. The archive reads the database's Performance Insights and the raise's tasks, so run `archive` while the raise is up.

Once a run is sealed, `load` rebuilds it: the verdict, the HTML report and the tables land in `load/.runs/<run id>/derived/`. An interrupted or failed run is sealed and rebuilt too, and its verdict says it ended early. `rebuild <run id>` does the same by hand from the run's folder; it needs no raise. A run is judged by the pass criteria its step had when it began. Smoke's judge no figure: a smoke run passes when its records are whole and agree and it ran its plan. A step with no criteria yet is rebuilt, and its verdict says it could not be judged.

## Watching a run

Each fact is written once: on aws-prod, the lines the generators and the backend write for the run's record also publish their figures as CloudWatch metrics, and so feed what you watch live. The generators publish what users experience, and the backend what it carries, including the push streams per task and the queue wait that the services will scale on.

The `<project>-load` dashboard, which core keeps for every raise, shows what users see first, then the app, how many tasks each service runs, the Fargate vCPU against its quota, and the load balancer, database and cache below. A graph that carries a pass criterion has it drawn as a red line. The cache's ECPU cap belongs to the step raised, so the cache row names each step's cap beside the ECPU consumed.

`monitor` shows the same facts in the terminal, with a figure past its limit in red and one nearing it in yellow.

## Generators on Spot

A load run's generators are many small Fargate Spot tasks, each carrying a
share of the users; `config/steps.ts` sets their size and number. When Spot
has no room at a launch, the launch is made again On-Demand, and the run's
record says which each generator ran on. Spot has a vCPU quota of its own, so
the generators do not compete with the app for vCPU. Seeding stays
On-Demand, in a few larger tasks.

The generators' image is not tied to the raise. `load-image` builds it again under a
fresh tag, and every later run of the raise starts its generators on that
tag. The run's record names the tag the generators really ran.

The harness watches the generators. One that stops before the run's end,
because Spot took its capacity back or because someone stopped it by hand,
is started again on the same slice of users. Its container is given the full
warning Spot allows to write its report. Every stopped task stays in the
run's record with the reason it stopped, even after ECS has forgotten it.

The worst case for a run prices its generators at Spot. A launch that falls
back to On-Demand costs more per hour than that, for as long as the run lasts.

## The way in

Cloudflare holds only the hostname's DNS record, pointing at a CloudFront
distribution. CloudFront ends TLS, and its web ACL lets in only the
operator's address and requests carrying the raise's load key, and limits
sign-ins per address. The load balancer behind it has no public address:
CloudFront reaches it through a VPC origin, over plain HTTP inside AWS. The
web ACL lives in its own stack in `us-east-1`, the only region CloudFront
takes one from, and `up` raises it before the app, `down` removes it after.
Creating the distribution takes some minutes, and deleting it as long again.

`load` goes through CloudFront, as users do. Every generator leaves the load
stack's network through one NAT gateway with one Elastic IP, and the web ACL
lets the generators in by the load key they carry, not by that address, so
nothing at the origin opens or closes with a run. `load` deletes the stack
once the run is sealed, or at once when it fails before the run begins
recording. A run that could not be sealed keeps its stack for `archive`, and
`down` or the safety net, 150 minutes after the stack started, takes it then.
The gateway is in the run's worst case, and so are CloudFront's and the web
ACL's charges for the run's traffic.

The generators all run in one region, so they reach one or a few nearby edge
locations, where real users would spread across many. Read AWS's guidance on
load testing CloudFront before a step50-sized run.

## Steps

`seed`, `smoke`, `step10`, `step50` and `step100` run fixed task counts.
`scale10` and `scale50` rehearse production's scaling at step10's and
step50's loads: the API, the worker and auth start at their floors and
scale on CPU, with no warm-up. `scale10`'s 10,000 users arrive over 30
minutes, hold for 15 and leave over 20. `scale50`'s 50,000 arrive over 45,
hold for 20 and leave over 30, and its ceilings are step50's counts.
`step-prod` is the production shape, and runs no generators.

A service that scales is held near its CPU target, and only that removes
tasks, slowly. Holding near the target adds tasks only after several
minutes above it, a few at a time, so a quick scale-out at the same target
adds them from the first minute's reading, in larger leaps the further CPU
is past it. Its settings sit beside the target in `config/steps.ts`.

Every step runs the API and the worker as separate services sharing
Valkey. `seed` creates the synthetic population once and snapshots the
database. Every later raise restores the newest seed snapshot that is
available, says which as it deploys, and keeps it on resume. A run's record
names the seed it ran on.

## Checking changes without an account

```bash
npm run check                                    # typecheck, test, then synthesize every stack
terraform -chdir=cloudflare/core init -backend=false && terraform -chdir=cloudflare/core validate
terraform -chdir=cloudflare/app init -backend=false && terraform -chdir=cloudflare/app validate
```
