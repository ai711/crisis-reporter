#!/usr/bin/env python3
"""
check_i18n_coverage.py
======================
CI guard: every literal t('key') call in web/src and mobile/src must be
covered by _SEED_KEYS (the translation pipeline) OR by the platform's own
static en.json bundle (English-only fallback).

FOUR checks are performed:

  CHECK A — Pipeline gap (WARNING, non-blocking by default)
    A key is in en.json AND used in code AND absent from _SEED_KEYS.
    These are translated in English but NEVER reach non-English speakers.
    Exit code 1 when --strict is passed.

  CHECK B — English broken (ERROR, always blocking)
    A key is used in platform code AND absent from THAT PLATFORM's en.json
    AND absent from _SEED_KEYS.
    Platform-specific: web code vs web en.json, mobile code vs mobile en.json.
    Exit code 2 always.

    (Previous versions used a union of both en.json files, which masked
    mobile keys that existed only in web/src/locales/en.json — those would
    appear covered but fail at mobile static-fallback time when offline.)

  CHECK C — Dead seed keys (INFO, never blocking)
    A key is in _SEED_KEYS but not called by any literal t() in code.
    Dynamic template-literal keys are excluded via known pattern prefixes.
    Printed as informational; does not affect exit code.

  CHECK D — Cross-platform locale gap (WARNING, non-blocking)
    A key is used on one platform and exists in that platform's code and
    seed_keys (so it works online), but is absent from the OTHER platform's
    en.json. Affects offline static fallback only.
    E.g. mobile code uses a key that is only in web/src/locales/en.json — a
    reporter offline on Android would get the key name instead of English text.
    Suppress with --no-platform-gap.

Usage
-----
  python scripts/check_i18n_coverage.py               # standard run
  python scripts/check_i18n_coverage.py --strict      # also fail on CHECK A
  python scripts/check_i18n_coverage.py --no-dead     # suppress CHECK C output
  python scripts/check_i18n_coverage.py --no-platform-gap  # suppress CHECK D

Exit codes
----------
  0 — all checks passed (or only warnings in non-strict mode)
  1 — CHECK A failures (strict mode only)
  2 — CHECK B failures (always)
  3 — both CHECK A (strict) and CHECK B failures
"""
import re, json, os, sys, argparse
from collections import defaultdict

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))

# Keys constructed via template literals — grep can't find them literally.
# Exclude them from the "dead seed key" warning.
DYNAMIC_PREFIXES = [
    "SAFETY_DISASTER_",   # t(`SAFETY_DISASTER_${id}_LABEL`)
    "SAFETY_TIP_",        # server-side translation lookup via content endpoints (?lang=) — no t() calls
    "disaster_types.",    # t(`disaster_types.${v}`)
    "crisis_types.",      # t(`crisis_types.${ct.key}`) in CrisisTypeModal.tsx
    "faq.q",              # t(`${baseKey}_answer`) etc.
    "faq_m.q",            # same pattern, mobile FAQ
    "map.damage_",        # t(`map.damage_${level}`)
    "my_reports.damage_", # same pattern
    "Q1_OPT_", "Q2_OPT_", "Q3_OPT_", "Q4_OPT_",
    "Q5_OPT_", "Q6_OPT_", "Q7_OPT_", "Q8_OPT_",
    "Q1_LABEL", "Q2_LABEL", "Q3_LABEL", "Q4_LABEL",
    "Q5_LABEL", "Q6_LABEL", "Q7_LABEL", "Q8_LABEL",
    "Q8_KEY_MAP",         # used as dict key, not direct t() argument
    "whatCanIReport.types", # t("whatCanIReport.types", { returnObjects: true }) — fetches whole subtree
    "stepper.step_",      # t(I18N_KEYS[step]) dict lookup in SubmissionStepper.tsx
    "menu.",              # t(item.labelKey) variable access in SideMenu.tsx — all menu.* keys are dynamic
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
    Handles both:
      - t('key')                  — single-arg form
      - t("key", { options })     — multi-arg form (defaultValue, count, etc.)
    Skips template literals (those are dynamic, handled by DYNAMIC_PREFIXES).
    Uses pure Python file walking so it works on any OS (no grep binary needed).
    """
    # Pattern requires:
    #   - t is NOT preceded by a word character (letter, digit, _ or $)
    #     so get('window'), createElement('canvas'), import('./x') are excluded
    #   - t( is followed immediately by a quote, then the key
    #   - Does NOT require a closing ) so t("key", { options }) is captured too
    pat = re.compile(r"""(?<![A-Za-z0-9_$])t\(['"]([^'"]+)['"]""")
    keys = set()
    for dirpath, _, filenames in os.walk(src_dir):
        for fname in filenames:
            if not (fname.endswith(".ts") or fname.endswith(".tsx")):
                continue
            fpath = os.path.join(dirpath, fname)
            try:
                with open(fpath, encoding="utf-8", errors="ignore") as f:
                    content = f.read()
            except Exception:
                continue
            for m in pat.finditer(content):
                keys.add(m.group(1))
    return keys


def is_dynamic(key):
    return any(key.startswith(p) or key == p.rstrip("_") for p in DYNAMIC_PREFIXES)


def find_files_for_key(key, src_dirs):
    """Return list of relative file paths that contain a literal t('key') call."""
    pat = re.compile(r"""(?<![A-Za-z0-9_$])t\(['"]([^'"]+)['"]""")
    hits = []
    for src_dir in src_dirs:
        for dirpath, _, filenames in os.walk(src_dir):
            for fname in filenames:
                if not (fname.endswith(".ts") or fname.endswith(".tsx")):
                    continue
                fpath = os.path.join(dirpath, fname)
                try:
                    with open(fpath, encoding="utf-8", errors="ignore") as f:
                        content = f.read()
                except Exception:
                    continue
                if any(m.group(1) == key for m in pat.finditer(content)):
                    hits.append(os.path.relpath(fpath, ROOT))
    return hits


# ── main ───────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--strict",  action="store_true",
                        help="Fail (exit 1) on CHECK A pipeline-gap findings")
    parser.add_argument("--no-dead", action="store_true",
                        help="Suppress CHECK C dead-key output")
    parser.add_argument("--no-platform-gap", action="store_true",
                        help="Suppress CHECK D cross-platform locale-gap output")
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

    # Union for CHECK A (pipeline coverage is platform-agnostic)
    all_en_keys = set(web_flat) | set(mob_flat)

    web_code_keys = grep_literal_keys(web_src)
    mob_code_keys = grep_literal_keys(mob_src)
    all_code_keys = web_code_keys | mob_code_keys

    # ── CHECK A: in en.json + used in code, but NOT in _SEED_KEYS ────────────
    # Union: if either platform has it in en.json, English works somewhere;
    # the pipeline gap is the common concern (non-English speakers).
    check_a = sorted(
        k for k in all_code_keys
        if k in all_en_keys and k not in seed_keys and not is_dynamic(k)
    )

    # ── CHECK B: platform-specific — used in platform code, NOT in THAT
    #    platform's en.json, AND NOT in _SEED_KEYS (both fallbacks missing) ──
    check_b_web = sorted(
        k for k in web_code_keys
        if k not in web_flat and k not in seed_keys and not is_dynamic(k)
    )
    check_b_mob = sorted(
        k for k in mob_code_keys
        if k not in mob_flat and k not in seed_keys and not is_dynamic(k)
    )

    # ── CHECK C: in _SEED_KEYS but no literal t() call found ─────────────────
    check_c = sorted(
        k for k in seed_keys
        if k not in all_code_keys and not is_dynamic(k)
    )

    # ── CHECK D: cross-platform locale gap ────────────────────────────────────
    # Mobile code uses a key that exists in web en.json but not mobile en.json.
    # Key may be in seed_keys (works online), but offline Android falls through
    # to static en.json and won't find it → shows the raw key string.
    check_d_mob_missing = sorted(
        k for k in mob_code_keys
        if k in web_flat and k not in mob_flat and not is_dynamic(k)
    )
    # Symmetric: web code uses a key only in mobile en.json.
    check_d_web_missing = sorted(
        k for k in web_code_keys
        if k in mob_flat and k not in web_flat and not is_dynamic(k)
    )

    # ── Report ────────────────────────────────────────────────────────────────
    ok = True
    exit_code = 0

    # CHECK B — web
    if check_b_web:
        print(f"\n{'='*60}")
        print(f"CHECK B (WEB) — ENGLISH BROKEN ({len(check_b_web)} keys)")
        print("Used in web code — absent from web/src/locales/en.json AND _SEED_KEYS.")
        print("Web users see a missing-translation fallback right now.")
        print("="*60)
        for k in check_b_web:
            hits = find_files_for_key(k, [web_src])
            print(f"  [BROKEN-WEB] {k}  ({', '.join(hits) if hits else 'location unknown'})")
        ok = False
        exit_code |= 2

    # CHECK B — mobile
    if check_b_mob:
        print(f"\n{'='*60}")
        print(f"CHECK B (MOBILE) — ENGLISH BROKEN ({len(check_b_mob)} keys)")
        print("Used in mobile code — absent from mobile/src/locales/en.json AND _SEED_KEYS.")
        print("Mobile users see a missing-translation fallback right now.")
        print("="*60)
        for k in check_b_mob:
            hits = find_files_for_key(k, [mob_src])
            print(f"  [BROKEN-MOB] {k}  ({', '.join(hits) if hits else 'location unknown'})")
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

    if not check_a and not check_b_web and not check_b_mob:
        print("CHECK A + B: PASS -- all t() keys are covered by _SEED_KEYS or en.json")

    if check_c and not args.no_dead:
        print(f"\n{'='*60}")
        print(f"CHECK C — INFO: {len(check_c)} seed keys with no literal t() call")
        print("(May be dynamic/template-literal keys not caught by grep — review manually)")
        print("="*60)
        for k in check_c[:20]:
            print(f"  [DEAD?] {k}")
        if len(check_c) > 20:
            print(f"  ... and {len(check_c) - 20} more (run with --no-dead to suppress)")

    if (check_d_mob_missing or check_d_web_missing) and not args.no_platform_gap:
        total_d = len(check_d_mob_missing) + len(check_d_web_missing)
        print(f"\n{'='*60}")
        print(f"CHECK D — PLATFORM GAP ({total_d} keys)")
        print("Keys used on one platform but absent from that platform's en.json.")
        print("Online: works (seed_keys pipeline). Offline static fallback: BROKEN.")
        print("Fix: copy the key into the missing platform's en.json.")
        print("Suppress with --no-platform-gap if offline fallback is not a concern.")
        print("="*60)
        for k in check_d_mob_missing:
            print(f"  [MOBILE-MISSING] {k}  (in web en.json, not mobile en.json)")
        for k in check_d_web_missing:
            print(f"  [WEB-MISSING] {k}  (in mobile en.json, not web en.json)")

    en_keys_count = len(all_en_keys)
    print(f"\n{'PASS' if ok else 'FAIL'}  (seed_keys={len(seed_keys)}, "
          f"code_keys={len(all_code_keys)}, en_keys={en_keys_count})")
    sys.exit(exit_code)


if __name__ == "__main__":
    main()
