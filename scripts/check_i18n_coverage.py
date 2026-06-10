#!/usr/bin/env python3
"""
check_i18n_coverage.py
======================
CI guard: every literal t('key') call in web/src and mobile/src must be
covered by _SEED_KEYS (the translation pipeline) OR by the static en.json
bundle (English-only fallback).

THREE checks are performed:

  CHECK A — Pipeline gap (WARNING, non-blocking by default)
    A key is in en.json AND used in code AND absent from _SEED_KEYS.
    These are translated in English but NEVER reach non-English speakers.
    Exit code 1 when --strict is passed.

  CHECK B — English broken (ERROR, always blocking)
    A key is used in code AND absent from BOTH en.json AND _SEED_KEYS.
    These produce a missing-translation fallback even in English right now.
    Exit code 2 always.

  CHECK C — Dead seed keys (INFO, never blocking)
    A key is in _SEED_KEYS but not called by any literal t() in code.
    Dynamic template-literal keys are excluded via known pattern prefixes.
    Printed as informational; does not affect exit code.

Usage
-----
  python scripts/check_i18n_coverage.py            # standard run
  python scripts/check_i18n_coverage.py --strict   # also fail on CHECK A
  python scripts/check_i18n_coverage.py --no-dead  # suppress CHECK C output

Exit codes
----------
  0 — all checks passed (or only warnings in non-strict mode)
  1 — CHECK A failures (strict mode only)
  2 — CHECK B failures (always)
  3 — both CHECK A (strict) and CHECK B failures
"""
import re, json, os, subprocess, sys, argparse
from collections import defaultdict

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))

# Keys constructed via template literals — grep can't find them literally.
# Exclude them from the "dead seed key" warning.
DYNAMIC_PREFIXES = [
    "SAFETY_DISASTER_",   # t(`SAFETY_DISASTER_${id}_LABEL`)
    "disaster_types.",    # t(`disaster_types.${v}`)
    "faq.q",              # t(`${baseKey}_answer`) etc.
    "faq_m.q",            # same pattern, mobile FAQ
    "map.damage_",        # t(`map.damage_${level}`)
    "my_reports.damage_", # same pattern
    "Q1_OPT_", "Q2_OPT_", "Q3_OPT_", "Q4_OPT_",
    "Q5_OPT_", "Q6_OPT_", "Q7_OPT_", "Q8_OPT_",
    "Q1_LABEL", "Q2_LABEL", "Q3_LABEL", "Q4_LABEL",
    "Q5_LABEL", "Q6_LABEL", "Q7_LABEL", "Q8_LABEL",
    "Q8_KEY_MAP",         # used as dict key, not direct t() argument
]

# ── helpers ────────────────────────────────────────────────────────────────────

def flatten_json(obj, prefix=""):
    out = {}
    for k, v in obj.items():
        full = f"{prefix}.{k}" if prefix else k
        if isinstance(v, dict):
            out.update(flatten_json(v, full))
        else:
            out[full] = str(v)
    return out


def load_seed_keys(lang_pkg_path):
    """Parse _SEED_KEYS — handles lines where English text contains \\\" escapes."""
    with open(lang_pkg_path, encoding="utf-8") as f:
        lines = f.readlines()
    keys = set()
    in_seed = False
    for line in lines:
        if "_SEED_KEYS: list[tuple" in line:
            in_seed = True
        if in_seed:
            # Match the first element (key name) — stops before the first comma+space
            m = re.match(r'\s*\("([^"]+)",', line)
            if m:
                keys.add(m.group(1))
    return keys


def grep_literal_keys(src_dir):
    """
    Extract all literal string arguments passed to t() in .ts/.tsx files.
    Handles both t('key') and t("key") forms.
    Skips template literals (those are dynamic, handled by DYNAMIC_PREFIXES).
    """
    result = subprocess.run(
        ["grep", "-rh", "--include=*.ts", "--include=*.tsx",
         r"-E", r"""t\(['"][^'"]+['"]\)""", src_dir],
        capture_output=True, text=True
    )
    keys = set()
    for line in result.stdout.splitlines():
        # Extract all t('...') and t("...") occurrences on this line
        for m in re.finditer(r"""t\(['"]([^'"]+)['"]\)""", line):
            keys.add(m.group(1))
    return keys


def is_dynamic(key):
    return any(key.startswith(p) or key == p.rstrip("_") for p in DYNAMIC_PREFIXES)


# ── main ───────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--strict",  action="store_true",
                        help="Fail (exit 1) on CHECK A pipeline-gap findings")
    parser.add_argument("--no-dead", action="store_true",
                        help="Suppress CHECK C dead-key output")
    args = parser.parse_args()

    lang_pkg  = os.path.join(ROOT, "backend", "app", "routers", "language_packages.py")
    web_en    = os.path.join(ROOT, "web",    "src", "locales", "en.json")
    mob_en    = os.path.join(ROOT, "mobile", "src", "locales", "en.json")
    web_src   = os.path.join(ROOT, "web",    "src")
    mob_src   = os.path.join(ROOT, "mobile", "src")

    seed_keys = load_seed_keys(lang_pkg)

    with open(web_en, encoding="utf-8") as f:
        web_flat = flatten_json(json.load(f))
    with open(mob_en, encoding="utf-8") as f:
        mob_flat = flatten_json(json.load(f))

    all_en_keys = set(web_flat) | set(mob_flat)

    web_code_keys = grep_literal_keys(web_src)
    mob_code_keys = grep_literal_keys(mob_src)
    all_code_keys = web_code_keys | mob_code_keys

    # ── CHECK A: in en.json + used in code, but NOT in _SEED_KEYS ────────────
    check_a = sorted(
        k for k in all_code_keys
        if k in all_en_keys and k not in seed_keys and not is_dynamic(k)
    )

    # ── CHECK B: used in code, NOT in en.json, NOT in _SEED_KEYS ─────────────
    check_b = sorted(
        k for k in all_code_keys
        if k not in all_en_keys and k not in seed_keys and not is_dynamic(k)
    )

    # ── CHECK C: in _SEED_KEYS but no literal t() call found ─────────────────
    check_c = sorted(
        k for k in seed_keys
        if k not in all_code_keys and not is_dynamic(k)
    )

    # ── Report ────────────────────────────────────────────────────────────────
    ok = True
    exit_code = 0

    if check_b:
        print(f"\n{'='*60}")
        print(f"CHECK B — ENGLISH BROKEN ({len(check_b)} keys)")
        print("These t() calls have no match in en.json OR _SEED_KEYS.")
        print("English users see a missing-translation fallback right now.")
        print("="*60)
        for k in check_b:
            # Find which files call this key
            files_web = subprocess.run(
                ["grep", "-rl", "--include=*.ts", "--include=*.tsx", k, web_src],
                capture_output=True, text=True
            ).stdout.strip().replace(ROOT + os.sep, "")
            files_mob = subprocess.run(
                ["grep", "-rl", "--include=*.ts", "--include=*.tsx", k, mob_src],
                capture_output=True, text=True
            ).stdout.strip().replace(ROOT + os.sep, "")
            locations = ", ".join(filter(None, [files_web, files_mob]))
            print(f"  [BROKEN] {k}  ({locations})")
        ok = False
        exit_code |= 2

    if check_a:
        print(f"\n{'='*60}")
        print(f"CHECK A — PIPELINE GAP ({len(check_a)} keys)")
        print("These keys are in en.json (English works) but NOT in _SEED_KEYS.")
        print("Non-English speakers always see English for these strings.")
        if args.strict:
            print("STRICT MODE: this is a failure.")
        else:
            print("Add these keys to _SEED_KEYS in backend/app/routers/language_packages.py")
            print("Run with --strict to make this a blocking failure in CI.")
        print("="*60)
        # Group by top-level namespace for readability
        by_ns = defaultdict(list)
        for k in check_a:
            by_ns[k.split(".")[0]].append(k)
        for ns, keys in sorted(by_ns.items()):
            print(f"  {ns}.*  ({len(keys)} keys)")
            for k in keys[:3]:
                print(f"    {k}")
            if len(keys) > 3:
                print(f"    ... and {len(keys) - 3} more")
        if args.strict:
            ok = False
            exit_code |= 1

    if not check_a and not check_b:
        print("CHECK A + B: PASS — all t() keys are covered by _SEED_KEYS or en.json")

    if check_c and not args.no_dead:
        print(f"\n{'='*60}")
        print(f"CHECK C — INFO: {len(check_c)} seed keys with no literal t() call")
        print("(May be dynamic/template-literal keys not caught by grep — review manually)")
        print("="*60)
        for k in check_c[:20]:
            print(f"  [DEAD?] {k}")
        if len(check_c) > 20:
            print(f"  ... and {len(check_c) - 20} more (run with --no-dead to suppress)")

    print(f"\n{'PASS' if ok else 'FAIL'}  (seed_keys={len(seed_keys)}, "
          f"code_keys={len(all_code_keys)}, en_keys={len(all_en_keys)})")
    sys.exit(exit_code)


if __name__ == "__main__":
    main()
