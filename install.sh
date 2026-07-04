#!/bin/sh
set -eu

ROOT="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
APP_DIR="$HOME/.local/share/tennis-booker"
BIN_DIR="$HOME/.local/bin"
VENV_DIR="$APP_DIR/.venv"

mkdir -p "$APP_DIR" "$BIN_DIR"
install -m 700 "$ROOT/tennis_booker.py" "$APP_DIR/tennis_booker.py"
install -m 700 "$ROOT/tennis_tui.py" "$APP_DIR/tennis_tui.py"
install -m 600 "$ROOT/requirements.txt" "$APP_DIR/requirements.txt"
install -m 755 "$ROOT/bin/tennis-booker" "$BIN_DIR/tennis-booker"

"${PYTHON:-/usr/bin/python3}" -m venv "$VENV_DIR"
"$VENV_DIR/bin/python" -m pip install \
  --disable-pip-version-check \
  --quiet \
  --requirement "$APP_DIR/requirements.txt"

"$BIN_DIR/tennis-booker" install-agent

case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *)
    echo ""
    echo "Add this line to ~/.zshrc, then open a new terminal:"
    echo "  export PATH=\"\$HOME/.local/bin:\$PATH\""
    ;;
esac

echo ""
echo "Installed tennis-booker."
echo "Run: $BIN_DIR/tennis-booker"
