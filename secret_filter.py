"""git clean/smudge filter that keeps the admin password hash out of the repository.

The real hash lives in .env (not committed):
    AIMX_PASSWORD_HASH=123456789
On commit ("clean") the ADMIN_PASSWORD_HASH line of aim_gacha.js is stored with 0;
on checkout ("smudge") the value from .env is put back. Set it up once per clone:
    git config filter.adminhash.clean  "python secret_filter.py clean"
    git config filter.adminhash.smudge "python secret_filter.py smudge"
(.gitattributes maps aim_gacha.js to this filter.)
"""
import re
import sys
from pathlib import Path

LINE = re.compile(r"const ADMIN_PASSWORD_HASH = \d+;[^\n]*")
PLACEHOLDER = "const ADMIN_PASSWORD_HASH = 0; // real value from .env (AIMX_PASSWORD_HASH), see README"


def env_hash():
    env = Path(__file__).resolve().parent / ".env"
    if env.exists():
        for line in env.read_text(encoding="utf-8").splitlines():
            key, _, value = line.partition("=")
            if key.strip() == "AIMX_PASSWORD_HASH" and value.strip().isdigit():
                return value.strip()
    return None


def main():
    mode = sys.argv[1] if len(sys.argv) > 1 else ""
    data = sys.stdin.buffer.read().decode("utf-8")
    if mode == "clean":
        data = LINE.sub(PLACEHOLDER, data, count=1)
    elif mode == "smudge":
        value = env_hash()
        if value:
            data = LINE.sub(f"const ADMIN_PASSWORD_HASH = {value}; // from .env", data, count=1)
    sys.stdout.buffer.write(data.encode("utf-8"))


if __name__ == "__main__":
    main()
