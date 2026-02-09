---
name: create-pr
description: Run tests/lint, analyze git diff, and create a GitHub PR with optimized token usage
argument-hint: [base-branch] [--draft]
context: fork
model: sonnet
disable-model-invocation: true
allowed-tools: Bash(npm test) Bash(npm run check:ci) Bash(git:*) Bash(gh:*) Read Grep Glob
---

# Create Pull Request

Create a GitHub pull request with automated validation.

## Arguments

Parse `$ARGUMENTS` to determine:
- **Base branch**: First argument (not starting with `--`), defaults to `main`
- **Draft mode**: `--draft` flag present anywhere

Examples:
- `/create-pr` → base=`main`, draft=false
- `/create-pr develop` → base=`develop`, draft=false
- `/create-pr main --draft` → base=`main`, draft=true

## Workflow

Follow these steps sequentially. Stop immediately on any failure.

### 1. Pre-flight Checks

```bash
# Ensure we're not on main
current_branch=$(git branch --show-current)
if [ "$current_branch" = "main" ]; then
  echo "ERROR: Cannot create PR from main branch"
  exit 1
fi

# Fetch latest
git fetch origin
```

### 2. Run Tests

```bash
npm test
```

If tests fail: report the error and STOP. Do not proceed.

### 3. Run Lint Check

```bash
npm run check:ci
```

If lint fails: report the error, suggest running `npm run check` to auto-fix, and STOP.

### 4. Analyze Changes

Gather information about all changes since diverging from base branch:

```bash
git log <base>...HEAD --oneline
git log <base>...HEAD --format="%h %s%n%b"
git diff <base>...HEAD --stat
git diff <base>...HEAD
```

IMPORTANT: Analyze ALL commits in the branch, not just the latest one.

### 5. Generate PR Title and Description

**Title rules:**
- Max 70 characters
- Format: `<type>: <brief description>`
- Types: `feat`, `fix`, `refactor`, `test`, `docs`, `chore`, `perf`, `ci`

**Description format:**

```markdown
## Summary
<2-4 bullet points summarizing key changes>

## Test plan
- [ ] Tests pass (`npm test`)
- [ ] Lint passes (`npm run check:ci`)
- [ ] <manual verification steps if applicable>

🤖 Generated with [Claude Code](https://claude.com/claude-code) `/create-pr` skill
```

Focus on "why" not just "what". Be concise.

### 6. Push and Create PR

```bash
# Push if needed
git push -u origin "$(git branch --show-current)"

# Create PR (use --draft if flag was set)
gh pr create --base <base-branch> [--draft] --title "<title>" --body "$(cat <<'EOF'
<description>
EOF
)"
```

### 7. Return Result

Return the PR URL to the user.

## Error Handling

- **Not on feature branch**: "Create and checkout a feature branch first"
- **Tests fail**: Show error output, suggest fixing and re-running `/create-pr`
- **Lint fails**: Show error output, suggest `npm run check` to auto-fix
- **Uncommitted changes**: "Commit or stash changes first"
- **No commits**: "No changes found between current branch and base"
