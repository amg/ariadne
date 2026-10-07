# Project Skills Index

This index provides a Just-In-Time (JIT) map of available project-specific skills. 
When a task matches a description below, you MUST use the `read` tool to load the corresponding `SKILL.md` file before proceeding.

## Core Project Skills

<available_skills>
  <skill>
    <name>code-quality</name>
    <description>Defines code quality standards, complexity limits, testing governance, and architectural decision framework.</description>
    <location>alex-chat-bot/.pi/agent/skills/code-quality/SKILL.md</location>
  </skill>
  <skill>
    <name>docs-quality</name>
    <description>Mandatory rules for code comments, JSDoc, and project documentation: no ticket/spec/ADR references, no doc citations, no narration or history, no implementation leaks in interface comments. Load BEFORE writing or modifying any comment, JSDoc, or doc — the comment-hygiene gate check enforces the gross classes mechanically.</description>
    <location>alex-chat-bot/.pi/agent/skills/docs-quality/SKILL.md</location>
  </skill>
  <skill>
    <name>workflow-gate</name>
    <description>Runs the project's validation gate (`npm run gate`) after code changes to ensure type checking, linting, tests, or builds are not broken.</description>
    <location>alex-chat-bot/.pi/agent/skills/workflow-gate/SKILL.md</location>
  </skill>
  <skill>
    <name>db</name>
    <description>Conventions for the Postgres/Kysely layer — migrations use the typed schema builder, and DB tests run against real Postgres, never mocks. Use when creating or editing migrations, or when writing database/repository tests.</description>
    <location>alex-chat-bot/.pi/agent/skills/db/SKILL.md</location>
  </skill>
  <skill>
    <name>queue</name>
    <description>Conventions for the durable queue (graphile-worker on the queues schema) — task payloads are typed by task name through the GraphileWorker.Tasks registry, never re-validated or re-shaped at runtime. Use when creating or editing queue tasks, enqueuing jobs, changing a task's payload, or writing queue tests.</description>
    <location>alex-chat-bot/.pi/agent/skills/queue/SKILL.md</location>
  </skill>
  <skill>
    <name>domain-language</name>
    <description>Enforces linguistic philosophy, naming conventions, and domain vocabulary rules to ensure clear, precise, and unambiguous communication across the codebase.</description>
    <location>alex-chat-bot/.pi/agent/skills/domain-language/SKILL.md</location>
  </skill>
  <skill>
    <name>writing-ui-components</name>
    <description>Guidelines for building UI components, splitting bloated files into folders, handling subcomponents, and managing TypeScript exports.</description>
    <location>alex-chat-bot/.pi/agent/skills/writing-ui-components/SKILL.md</location>
  </skill>
  <skill>
    <name>git-workflow</name>
    <description>Guidelines for git merges, branching, and repository management.</description>
    <location>alex-chat-bot/.pi/agent/skills/git-workflow/SKILL.md</location>
  </skill>
</available_skills>

## Global Skills

Third-party skills (Matt Pocock) are available globally from `~/.pi/agent/skills/third-party/`.
These are auto-discovered by the agent and don't need to be listed here.