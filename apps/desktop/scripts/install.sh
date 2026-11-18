#!/bin/sh
# Builds lamsa and installs it for the current user: the `lamsa` CLI and a `lamsa-desktop` launcher
# on PATH (which `lamsa open` uses), a desktop entry, and an icon, so it shows in the app grid and dock.
set -eu

APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
REPO="$(cd "$APP_DIR/../.." && pwd)"
BIN="$HOME/.local/bin"
APPS="$HOME/.local/share/applications"
ICONS="$HOME/.local/share/icons/hicolor/scalable/apps"

(cd "$REPO" && pnpm build)

mkdir -p "$BIN" "$APPS" "$ICONS"
cp "$APP_DIR/resources/icon.svg" "$ICONS/lamsa.svg"
for size in 16 32 48 64 128 256 512; do
  mkdir -p "$HOME/.local/share/icons/hicolor/${size}x${size}/apps"
  cp "$APP_DIR/resources/icons/$size.png" "$HOME/.local/share/icons/hicolor/${size}x${size}/apps/lamsa.png"
done

cat > "$BIN/lamsa-desktop" <<LAUNCHER
#!/bin/sh
APP_DIR="$APP_DIR"
unset ELECTRON_RENDERER_URL NODE_ENV
# Ties the window to lamsa.desktop so the dock, app grid and top bar show its name and icon.
export CHROME_DESKTOP=lamsa.desktop
export PATH="\$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin:\$PATH"
exec "\$APP_DIR/node_modules/electron/dist/electron" "\$APP_DIR" "\$@"
LAUNCHER
chmod +x "$BIN/lamsa-desktop"

# The CLI, for agents and the terminal.
chmod +x "$REPO/packages/cli/dist/cli.js"
ln -sf "$REPO/packages/cli/dist/cli.js" "$BIN/lamsa"

cat > "$APPS/lamsa.desktop" <<ENTRY
[Desktop Entry]
Type=Application
Name=lamsa
GenericName=Design editor
Comment=Design app UI with your coding agent
Exec=$BIN/lamsa-desktop
Icon=$HOME/.local/share/icons/hicolor/512x512/apps/lamsa.png
Terminal=false
Categories=Graphics;
StartupWMClass=lamsa
ENTRY

update-desktop-database "$APPS" 2>/dev/null || true
gtk-update-icon-cache -f -t "$HOME/.local/share/icons/hicolor" 2>/dev/null || true
echo "installed: $BIN/lamsa, $BIN/lamsa-desktop, $APPS/lamsa.desktop, $ICONS/lamsa.svg"
