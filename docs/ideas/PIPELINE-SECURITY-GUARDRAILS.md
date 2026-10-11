# Pipeline Security Guardrails

## Context
When implementing automated CI/CD pipelines (e.g., GitHub Actions, GitLab CI) for Infrastructure as Code (IaC) like AWS CDK, the pipeline inherently requires high-level privileges to provision and modify resources (VPCs, Security Groups, IAM roles). 

If a pipeline is compromised, or if a rogue workflow is introduced in a PR branch, an attacker could potentially relax network boundaries (such as modifying `allowAllOutbound: false` to `true` on database Security Groups) and deploy compromised infrastructure. 

## Guardrails (Pre-Requisites to CI/CD Implementation)

Before attaching any automated pipelines to the deployment process, the following guardrails should be considered:

### 1. OIDC with Strict Trust Policies
- **Avoid Long-Lived Credentials:** Do not store static AWS Access Keys in repository secrets.
- **OIDC Integration:** Use OpenID Connect (OIDC) to allow the pipeline to assume a temporary AWS IAM role.
- **Branch Enforcement:** The AWS IAM Role Trust Policy must explicitly enforce the `sub` (subject) claim to only trust requests originating from the `main` or `master` branch (e.g., `repo:org/repo:ref:refs/heads/main`). This prevents developers or attackers from modifying the workflow in a feature branch and running deployments against production.

### 2. Branch Protection Rules
- **Protect Default Branches:** Direct pushes to the default branch (`main`) must be disabled.
- **Mandatory Reviews:** All code changes (including workflow file modifications) must go through a Pull Request and require at least one approval from a designated code owner or senior engineer.
- **Status Checks:** Enforce status checks (like linting and tests) to pass before merging.

### 3. Separation of Concerns (Infra vs. App)
- **Least Privilege for Compute:** The pipeline responsible for deploying application updates (e.g., pushing new Docker images to ECS) should only have the IAM permissions required to update the task definition/service. It should **not** have permissions to mutate EC2 Security Groups or create IAM roles.
- **Restricted Infrastructure Deployments:** Core infrastructure changes (VPC, Security Groups, databases) should require a separate, highly privileged pipeline or be restricted to manual deployments by administrators, preferably utilizing `cdk diff` reviews.

### 4. Platform-Level Environment Approvals
- Utilize the CI/CD platform's native environment features (e.g., GitHub Environments).
- Map critical deployments to an environment (like `production`) that requires explicit, manual approval from authorized team members. Even if a workflow is maliciously modified to remove an approval step, the platform itself will pause execution until the environment-level approval is granted.
