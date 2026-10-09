#!/usr/bin/env bash
# Fonts for converting slide decks to PDF with LibreOffice.
# Most student decks (PowerPoint, Gamma exports) use Microsoft fonts:
# Verdana, Calibri, Tahoma, Trebuchet MS, Arial, Times New Roman.
# Without them LibreOffice substitutes wider fonts and text overflows its
# boxes. This installs the real Microsoft core fonts plus metric-compatible
# stand-ins (Carlito = Calibri, Caladea = Cambria, Wine Tahoma = Tahoma).
set -euo pipefail

echo "ttf-mscorefonts-installer msttcorefonts/accepted-mscorefonts-eula select true" | sudo debconf-set-selections
sudo apt-get update -qq
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends \
  libreoffice-impress fonts-dejavu fonts-liberation fonts-noto-core \
  fonts-crosextra-carlito fonts-crosextra-caladea fonts-noto-color-emoji \
  cabextract wget >/dev/null
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq fonts-wine >/dev/null || echo "fonts-wine not available"

# The Microsoft core fonts package downloads from SourceForge at install time;
# retry it, it fails now and then.
for i in 1 2 3; do
  if sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq ttf-mscorefonts-installer >/dev/null \
     && fc-list | grep -qi verdana; then
    break
  fi
  echo "mscorefonts attempt $i failed, retrying"
  sudo dpkg-reconfigure -f noninteractive ttf-mscorefonts-installer || true
  fc-list | grep -qi verdana && break
  sleep 10
done
fc-list | grep -qi verdana || echo "WARNING: Verdana still missing"

# Aliases for fonts we can't install: Tahoma -> Wine Tahoma (or DejaVu Sans),
# Segoe UI -> Noto Sans, Segoe UI Emoji -> Noto Color Emoji.
sudo tee /etc/fonts/conf.d/99-deck-aliases.conf >/dev/null <<'XML'
<?xml version="1.0"?>
<!DOCTYPE fontconfig SYSTEM "fonts.dtd">
<fontconfig>
  <alias binding="same"><family>Tahoma</family><prefer><family>Tahoma</family><family>DejaVu Sans</family></prefer></alias>
  <alias binding="same"><family>Segoe UI</family><prefer><family>Noto Sans</family></prefer></alias>
  <alias binding="same"><family>Segoe UI Emoji</family><prefer><family>Noto Color Emoji</family></prefer></alias>
  <alias binding="same"><family>Microsoft Sans Serif</family><prefer><family>Liberation Sans</family></prefer></alias>
</fontconfig>
XML
sudo fc-cache -f >/dev/null
for f in Verdana Tahoma Calibri Carlito "Trebuchet MS" Arial "Times New Roman"; do
  printf '%-16s -> %s\n' "$f" "$(fc-match "$f")"
done
