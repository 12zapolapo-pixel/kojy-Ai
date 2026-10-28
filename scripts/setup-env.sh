#!/usr/bin/env bash
# Creates .env for a KojyAI server: fresh random secrets plus the values only
# you know (your site address and Groq key). Safe to re-run — it never
# overwrites an existing .env unless you pass --force.
#
#   ./scripts/setup-env.sh            # interactive
#   ./scripts/setup-env.sh --force    # start over (keeps a .env.bak copy)
set -euo pipefail
cd "$(dirname "$0")/.."

if [[ -f .env && "${1:-}" != "--force" ]]; then
  echo ".env already exists — nothing changed. Use --force to recreate it (a backup is kept)."
  exit 0
fi
[[ -f .env ]] && cp .env .env.bak && echo "Saved the old file as .env.bak"

hex() { openssl rand -hex "$1"; }

# Best guess at this server's public IP, offered as the default.
guess_ip="$(curl -fsS --max-time 5 https://api.ipify.org 2>/dev/null || true)"

echo
echo "How will you open the site?"
echo "  1) http://<server-ip>                  (simplest, no HTTPS)"
echo "  2) https://<ip-with-dashes>.sslip.io   (free HTTPS, no domain needed — recommended)"
echo "  3) https://<your own domain>"
read -rp "Choose 1, 2 or 3 [2]: " mode
mode="${mode:-2}"

case "$mode" in
  1)
    read -rp "Server public IP [${guess_ip}]: " ip; ip="${ip:-$guess_ip}"
    frontend="http://${ip}"; site=":80" ;;
  2)
    read -rp "Server public IP [${guess_ip}]: " ip; ip="${ip:-$guess_ip}"
    host="${ip//./-}.sslip.io"
    frontend="https://${host}"; site="${host}" ;;
  3)
    read -rp "Domain (e.g. kojy.example.com): " host
    frontend="https://${host}"; site="${host}" ;;
  *) echo "Please answer 1, 2 or 3."; exit 1 ;;
esac

read -rp "Groq API key (https://console.groq.com/keys, Enter to add later): " groq

umask 077
sed \
  -e "s|^FRONTEND_URL=.*|FRONTEND_URL=${frontend}|" \
  -e "s|^SITE_ADDRESS=.*|SITE_ADDRESS=${site}|" \
  -e "s|^POSTGRES_PASSWORD=.*|POSTGRES_PASSWORD=$(hex 32)|" \
  -e "s|^REDIS_PASSWORD=.*|REDIS_PASSWORD=$(hex 32)|" \
  -e "s|^JWT_SECRET=.*|JWT_SECRET=$(hex 64)|" \
  -e "s|^ENCRYPTION_KEY=.*|ENCRYPTION_KEY=$(hex 32)|" \
  -e "s|^GROQ_API_KEY=.*|GROQ_API_KEY=${groq}|" \
  .env.example > .env

echo
echo "Wrote .env (only readable by you). Site address: ${frontend}"
echo "Keep a private copy of ENCRYPTION_KEY — without it saved bot tokens can't be read."
[[ -z "$groq" ]] && echo "Remember to put your GROQ_API_KEY into .env before starting."
echo "Next: docker compose up -d --build"
