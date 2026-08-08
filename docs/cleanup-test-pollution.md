# TODO — clean test pollution from the real `~/.claude`

**Status:** open. Root cause is fixed and verified; only the residue on this
machine remains.

**Context:** before commit `a50ddb0`, this repo's own test suites wrote into the
developer's actual `~/.claude`. `skills/settings-json.ts` and `skills/gc.ts`
resolved `~/.claude/settings.json` through a bare `homedir()` with no override
seam. Their comment claimed `$HOME` overrides worked, but bun's `os.homedir()`
caches its first value process-wide, and the suites' `mock.module("node:os")`
only reaches modules that resolve `homedir` *after* the mock is installed —
these two bound it earlier.

**Root cause: FIXED** in `a50ddb0` — both modules now expose the same
`_setHome` seam `claude-json.ts` already had (`_setSettingsJsonHome`,
`_setGcHome`), wired into `skills-e2e.test.ts` and `skills-crash.test.ts` with a
reset in `afterAll`. Verified by snapshotting the real `settings.json`, running
both suites, and diffing — byte-identical afterwards.

**Residue: NOT yet cleaned** (deliberately — this is outside the repo and edits
the user's global Claude Code config, so it needs an explicit go-ahead).

---

## 1. Phantom skill entries in `~/.claude/settings.json`

Three entries in the `skills[]` array point at test fixtures. Claude Code loads
them as real skills on every launch.

```
~/.local/share/operad/skills/cache/git+url/_data_data_com.termux_files_usr_tmp_operad-skills-e2e-repo-jzwzer/v0.1.0/skills/demo-skill
~/.local/share/operad/skills/cache/git+url/_data_data_com.termux_files_usr_tmp_operad-skills-e2e-repo-vxkeoa/v0.1.0/skills/demo-skill
~/.local/share/operad/skills/cache/git+url/_data_data_com.termux_files_usr_tmp_operad-skills-e2e-repo-wjkzne/v0.1.0/skills/demo-skill
```

They resolve (the cache dirs still exist), so this is not a dangling-path
warning — Claude Code is actually loading three fake `demo-skill` bundles.

**Inspect first:**

```sh
node -e 'const s=require(require("os").homedir()+"/.claude/settings.json");
console.log(JSON.stringify(s.skills,null,2))'
```

**Remove only the fixture entries** (leaves every other key untouched, and backs
the file up first):

```sh
node -e '
const fs=require("fs"), p=require("os").homedir()+"/.claude/settings.json";
fs.copyFileSync(p, p+".bak");
const s=JSON.parse(fs.readFileSync(p,"utf8"));
const before=(s.skills||[]).length;
s.skills=(s.skills||[]).filter(e=>!/operad-skills-(e2e|crash)-repo-/.test(e));
fs.writeFileSync(p, JSON.stringify(s,null,2)+"\n");
console.log(`skills[]: ${before} -> ${s.skills.length}; backup at ${p}.bak`);
'
```

Restart any running Claude Code sessions afterwards so they reload settings.

## 2. Stray fixture directories in the operad skill cache

Seven directories under `~/.local/share/operad/skills/cache/git+url/`:

```
_data_data_com.termux_files_usr_tmp_operad-skills-e2e-repo-jzwzer
_data_data_com.termux_files_usr_tmp_operad-skills-e2e-repo-vxkeoa
_data_data_com.termux_files_usr_tmp_operad-skills-e2e-repo-wjkzne
_data_data_com.termux_files_usr_tmp_c-test
_data_data_com.termux_files_usr_tmp_skill-a1
_data_data_com.termux_files_usr_tmp_test-skill
https:__github.com_anthropics_skills
```

The first six are unambiguously test fixtures (the sanitised locator encodes a
`$PREFIX/tmp/...` path that no longer exists). **`https:__github.com_anthropics_skills`
is NOT obviously test residue** — that is a real locator for `anthropics/skills`
and may be a genuine install. Leave it unless you know otherwise.

**Do step 1 before this** — removing cache dirs first turns the `settings.json`
entries into dangling paths.

```sh
CACHE="$HOME/.local/share/operad/skills/cache/git+url"
# Dry run — list what would go
ls -d "$CACHE"/_data_data_com.termux_files_usr_tmp_* 2>/dev/null
# Then remove
rm -rf "$CACHE"/_data_data_com.termux_files_usr_tmp_*
```

## 3. Check the skills table in the operad DB

The cache dirs may have matching rows in `~/.local/share/operad/memory.db`
(`skills`, `skill_active_version`, `skill_generation_refs`). If the dashboard's
skill marketplace panel lists `demo-skill` entries after steps 1–2, they are
coming from there.

```sh
bun -e '
const {Database}=require("bun:sqlite");
const db=new Database(require("os").homedir()+"/.local/share/operad/memory.db",{readonly:true});
try{ console.log(db.query("SELECT id,name FROM skills").all()); }
catch(e){ console.log("no skills table:", e.message); }
'
```

Prefer `operad skill remove <id>` over raw SQL — it runs the transactional
uninstall (revokes tool registrations, updates `settings.json`, tombstones the
row) rather than leaving the stores inconsistent.

---

## Verification after cleanup

```sh
# No fixture entries left
node -e 'const s=require(require("os").homedir()+"/.claude/settings.json");
console.log((s.skills||[]).filter(e=>/operad-skills-/.test(e)).length===0 ? "clean" : "still polluted")'

# And the leak stays sealed: snapshot, run the suites, diff
cp ~/.claude/settings.json "$PREFIX/tmp/settings.check"
bun test src/__tests__/skills-e2e.test.ts src/__tests__/skills-crash.test.ts
diff -q "$PREFIX/tmp/settings.check" ~/.claude/settings.json && echo "no leak"
```
