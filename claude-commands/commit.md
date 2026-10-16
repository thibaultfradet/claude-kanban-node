# Commit

Analyze the project's changes and propose grouped, coherent commits.

## Absolute rule: commit authorship

I am the **sole author** of every commit.
- No `Co-authored-by` in messages
- No mention of Claude, AI, or any tool in messages or metadata
- The commit must look exactly as if I had written it myself

## Step 1: Detect changes

1. Look at **unstaged files** first (`git diff`)
2. If nothing is unstaged, look at **staged files** (`git diff --cached`)
3. If files are staged, **unstage them right away** (`git restore --staged .`) before starting. This avoids committing everything in one block by accident. The changes stay in the working directory.

## Step 2: Analyze and split into batches

- Group changes by **logical coherence**, not by file
- One batch = one unit of meaning (a feature, a fix, a refactor, etc.)
- If the changes touch several distinct areas, make several distinct commits
- Never put everything in a single commit when the changes are unrelated
- Propose the split to the user and **wait for approval** before running anything

## Step 3: Commit message format

Strict convention:
```
<type>: <concise message in English>
```

Allowed types:
- `feat`: new feature
- `fix`: bug fix
- `chore`: technical task, dependencies, config
- `style`: purely visual changes or formatting

Message rules:
- In **English**
- **Concise**: one line, no long description
- Lowercase after the type
- No trailing period

Valid examples:
```
feat: add user authentication flow
fix: handle expired token on refresh
chore: update dependencies
style: align form inputs on login page
```

## Step 4: Run

For each approved batch, stage only the files it covers, then commit:
```bash
git add <batch files>
git commit -m "<type>: <message>"
```

Never use `git add .` or `git add -A` unless a batch explicitly contains every file.
