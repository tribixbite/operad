/**
 * run-tab-wrapper.test.ts — the dashboard "Run script" tab wrapper must
 * preload libtermux-exec.so.
 *
 * Regression for: a build script launched from the dashboard (cleverkeys
 * `build-on-termux.sh`) failed with `./gradlew: /usr/bin/env: bad
 * interpreter: No such file or directory` (gradle exit 126), while the same
 * script run from an interactive Termux shell succeeded. Root cause: the
 * TermuxService execute intent runs the generated wrapper WITHOUT Termux's
 * default LD_PRELOAD, so libtermux-exec.so's `/usr/bin/env → $PREFIX/bin/env`
 * shebang rewriting is absent and the kernel can't resolve `/usr/bin/env`.
 *
 * The wrapper re-exec's itself once with LD_PRELOAD set so the re-exec'd copy
 * starts with libtermux-exec.so loaded — covering both the target script's own
 * `/usr/bin/env` shebang AND any `/usr/bin/env` shebangs in its children.
 */
import { describe, test, expect } from "bun:test";
import { buildRunTabWrapper } from "../platform/android.js";

const LIB = "/data/data/com.termux/files/usr/lib/libtermux-exec.so";

describe("buildRunTabWrapper", () => {
  test("preloads libtermux-exec.so so /usr/bin/env shebangs resolve", () => {
    const w = buildRunTabWrapper("/proj/build.sh", "/proj", "myapp", LIB);
    expect(w).toContain(`export LD_PRELOAD="${LIB}`);
  });

  test("re-exec's self (with libtermux loaded) before running the target", () => {
    const w = buildRunTabWrapper("/proj/build.sh", "/proj", "myapp", LIB);
    // Loop guard prevents infinite self-re-exec.
    expect(w).toContain(`_TMX_LD_REEXEC`);
    expect(w).toContain(`exec "$0" "$@"`);
    const lines = w.split("\n");
    const reexecIdx = lines.findIndex((l) => l.includes(`exec "$0"`));
    const cdIdx = lines.findIndex((l) => l.startsWith("cd "));
    const runIdx = lines.findIndex((l) => l.startsWith(`exec "/proj/build.sh"`));
    expect(reexecIdx).toBeGreaterThan(0);
    expect(cdIdx).toBeGreaterThan(reexecIdx);
    expect(runIdx).toBeGreaterThan(cdIdx);
    expect(lines).toContain(`cd "/proj" || exit 1`);
  });

  test("idempotent — no-ops when the lib is already in LD_PRELOAD", () => {
    const w = buildRunTabWrapper("/proj/build.sh", "/proj", "myapp", LIB);
    // Guard clause skips re-adding when the path is already present.
    expect(w).toContain(`*":${LIB}:"*) ;;`);
    // Preserves any pre-existing entries instead of clobbering them.
    expect(w).toContain('${LD_PRELOAD:+:$LD_PRELOAD}');
  });

  test("omits the preload/re-exec entirely when the lib is absent", () => {
    const w = buildRunTabWrapper("/proj/build.sh", "/proj", "myapp", null);
    expect(w).not.toContain("LD_PRELOAD");
    expect(w).not.toContain("_TMX_LD_REEXEC");
    expect(w).toContain(`exec "/proj/build.sh"`);
  });
});
