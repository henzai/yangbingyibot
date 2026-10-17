# CLAUDE.md

@AGENTS.md

## Claude Code specific

- `AGENTS.md` is the single source of repository guidance for Codex and Claude
  Code. Update it instead of adding shared rules here.
- To add a repository skill, put it in `.agents/skills/<name>/` and link it with
  `ln -s ../../.agents/skills/<name> .claude/skills/<name>`. Keep only
  Claude-specific skills, such as `/create-pr`, directly in `.claude/skills/`.
