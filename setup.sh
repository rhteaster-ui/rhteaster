#!/usr/bin/env bash

# ==============================================================================
# RHTEASTER ONE-COMMAND INSTALLER
# Self-Hosted WhatsApp AI Agent + Web Ops Dashboard + CLI Toolkit
# Repository : https://github.com/rhteaster-ui/rhteaster
# Target OS  : Ubuntu / Debian Linux VPS
# ==============================================================================

set -e

GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BOLD='\033[1m'
NC='\033[0m'

REPO_URL="https://github.com/rhteaster-ui/rhteaster.git"
INSTALL_DIR="rhteaster"

OPT_BOT=""
OPT_OWNER=""
OPT_NAME=""
OPT_PORT=""
OPT_PIN=""
NON_INTERACTIVE=0

for arg in "$@"; do
    case "$arg" in
        --bot=*) OPT_BOT="${arg#*=}" ;;
        --owner=*) OPT_OWNER="${arg#*=}" ;;
        --name=*) OPT_NAME="${arg#*=}" ;;
        --port=*) OPT_PORT="${arg#*=}" ;;
        --pin=*) OPT_PIN="${arg#*=}" ;;
        -y|--yes|--non-interactive) NON_INTERACTIVE=1 ;;
    esac
done

run_priv() {
    if [ "$(id -u)" -eq 0 ]; then
        "$@"
    elif command -v sudo >/dev/null 2>&1; then
        sudo "$@"
    else
        echo -e "${RED}Perintah butuh akses root atau sudo.${NC}"
        exit 1
    fi
}

echo -e "${BLUE}======================================================${NC}"
echo -e "${GREEN}${BOLD}   RHTEASTER · WHATSAPP AI AGENT + OPS DECK (v2.1)   ${NC}"
echo -e "${BLUE}   Baileys Multi-Device + Antigravity AI + CLI Tools  ${NC}"
echo -e "${BLUE}======================================================${NC}"

# 0. Clone atau update repo jika script dijalankan via curl | bash
if [ ! -f "package.json" ] || [ ! -d "dashboard" ]; then
    echo -e "\n${YELLOW}[Info] Menyiapkan repositori rhteaster...${NC}"
    if ! command -v git >/dev/null 2>&1; then
        run_priv apt-get update -y
        run_priv apt-get install -y git
    fi
    if [ ! -d "$INSTALL_DIR/.git" ]; then
        git clone "$REPO_URL" "$INSTALL_DIR"
    else
        echo -e "${BLUE}Folder $INSTALL_DIR sudah ada, menarik update terbaru...${NC}"
        git -C "$INSTALL_DIR" pull --ff-only || true
    fi
    cd "$INSTALL_DIR"
    echo -e "${GREEN}Direktori kerja: $(pwd)${NC}"
fi

# 1. Dependensi OS (curl, git, build-essential, ffmpeg)
echo -e "\n${YELLOW}[1/6] Memeriksa paket sistem dasar...${NC}"
run_priv apt-get update -y
run_priv apt-get install -y curl git build-essential ca-certificates ffmpeg >/dev/null 2>&1 || run_priv apt-get install -y curl git build-essential ca-certificates

# 2. Node.js v22 LTS (>= v20 required)
echo -e "\n${YELLOW}[2/6] Memeriksa Node.js...${NC}"
NEED_NODE=0
if ! command -v node >/dev/null 2>&1; then
    NEED_NODE=1
else
    NODE_MAJOR=$(node -v | sed 's/^v//' | cut -d. -f1)
    if [ "${NODE_MAJOR:-0}" -lt 20 ]; then
        NEED_NODE=1
    fi
fi
if [ "$NEED_NODE" -eq 1 ]; then
    echo -e "${BLUE}Memasang Node.js v22 LTS...${NC}"
    curl -fsSL https://deb.nodesource.com/setup_22.x | run_priv bash -
    run_priv apt-get install -y nodejs
fi
echo -e "${GREEN}Node.js siap: $(node -v) | NPM: $(npm -v)${NC}"

# 3. PM2 Process Manager
echo -e "\n${YELLOW}[3/6] Memeriksa PM2...${NC}"
if ! command -v pm2 >/dev/null 2>&1; then
    run_priv npm install -g pm2
fi
echo -e "${GREEN}PM2 siap: $(pm2 -v)${NC}"

# 4. Antigravity CLI (agy)
echo -e "\n${YELLOW}[4/6] Memeriksa Antigravity CLI (agy)...${NC}"
if ! command -v agy >/dev/null 2>&1 && [ ! -f "$HOME/.local/bin/agy" ] && [ ! -f "/usr/local/bin/agy" ]; then
    echo -e "${BLUE}Mengunduh Antigravity CLI resmi Google...${NC}"
    curl -fsSL https://antigravity.google/cli/install.sh | bash || true
    export PATH="$HOME/.local/bin:/usr/local/bin:$PATH"
    if ! grep -qxF 'export PATH="$HOME/.local/bin:$PATH"' "$HOME/.bashrc" 2>/dev/null; then
        echo 'export PATH="$HOME/.local/bin:$PATH"' >> "$HOME/.bashrc"
    fi
fi
if [ -f "$HOME/.local/bin/agy" ] && [ ! -e "/usr/local/bin/agy" ]; then
    run_priv ln -sf "$HOME/.local/bin/agy" /usr/local/bin/agy || true
fi
if command -v agy >/dev/null 2>&1; then
    echo -e "${GREEN}Antigravity CLI (agy) tersedia: $(command -v agy)${NC}"
else
    echo -e "${YELLOW}Peringatan: Binary agy belum terdeteksi otomatis. Anda dapat memasangnya manual nanti.${NC}"
fi

# 5. Dependensi Node.js project + pasang command global rhteaster
echo -e "\n${YELLOW}[5/6] Memasang dependensi bot, dashboard, & Rhteaster CLI...${NC}"
npm install --omit=dev
mkdir -p logs session_auth temp_tasks data
if [ -f "bin/rhteaster.js" ]; then
    chmod +x bin/rhteaster.js
    run_priv ln -sf "$(pwd)/bin/rhteaster.js" /usr/local/bin/rhteaster || true
fi

# 6. Konfigurasi awal interaktif ramah pengguna awam
echo -e "\n${YELLOW}[6/6] Konfigurasi awal Bot WhatsApp & Dashboard...${NC}"
if [ "$NON_INTERACTIVE" -eq 0 ] && [ -r /dev/tty ]; then
    if [ ! -f "config.json" ] || [ -n "$OPT_BOT" ] || [ -n "$OPT_OWNER" ]; then
        echo -e "${BLUE}Isi data di bawah (tekan Enter untuk memakai nilai default):${NC}"
        if [ -z "$OPT_NAME" ]; then
            read -r -p "1. Nama Brand / Bot [Agency Client]: " OPT_NAME </dev/tty || true
        fi
        if [ -z "$OPT_OWNER" ]; then
            read -r -p "2. Nomor WA Owner/Admin Anda (cth 628123456789): " OPT_OWNER </dev/tty || true
        fi
        if [ -z "$OPT_BOT" ]; then
            read -r -p "3. Nomor WA untuk Bot (boleh kosong, nanti isi di Web Dashboard): " OPT_BOT </dev/tty || true
        fi
        if [ -z "$OPT_PORT" ]; then
            read -r -p "4. Port Web Dashboard [3000]: " OPT_PORT </dev/tty || true
        fi
        if [ -z "$OPT_PIN" ]; then
            read -r -p "5. PIN Keamanan Web Dashboard (kosongkan jika tanpa PIN): " OPT_PIN </dev/tty || true
        fi
    fi
fi

CFG_BRAND="${OPT_NAME:-Agency Client}"
CFG_OWNER="$OPT_OWNER"
CFG_BOT="$OPT_BOT"
CFG_PORT="${OPT_PORT:-3000}"
CFG_PIN="$OPT_PIN"

node -e '
const fs = require("fs");
const path = require("path");
const cfgPath = path.join(process.cwd(), "config.json");
const exPath = path.join(process.cwd(), "config.example.json");
let base = {};
try { base = JSON.parse(fs.readFileSync(cfgPath, "utf8")); }
catch (_) { try { base = JSON.parse(fs.readFileSync(exPath, "utf8")); } catch (_) {} }
const cleanPhone = (v) => {
  const s = String(v || "").replace(/[^0-9]/g, "");
  return s.startsWith("0") ? "62" + s.slice(1) : s;
};
if (process.env.CFG_BRAND) base.brandName = process.env.CFG_BRAND;
if (!base.botName) base.botName = base.brandName + " Bot";
if (process.env.CFG_OWNER) base.ownerNumber = cleanPhone(process.env.CFG_OWNER);
if (process.env.CFG_BOT) base.botNumber = cleanPhone(process.env.CFG_BOT);
if (process.env.CFG_PORT) base.dashboardPort = Number(process.env.CFG_PORT) || 3000;
if (process.env.CFG_PIN !== undefined && process.env.CFG_PIN !== "") base.dashboardPin = process.env.CFG_PIN;
fs.writeFileSync(cfgPath, JSON.stringify(base, null, 2));
' CFG_BRAND="$CFG_BRAND" CFG_OWNER="$CFG_OWNER" CFG_BOT="$CFG_BOT" CFG_PORT="$CFG_PORT" CFG_PIN="$CFG_PIN"

FINAL_PORT=$(node -e 'console.log(JSON.parse(require("fs").readFileSync("config.json","utf8")).dashboardPort || 3000)')

# Buka firewall UFW jika aktif
if command -v ufw >/dev/null 2>&1; then
    if run_priv ufw status 2>/dev/null | grep -qi "Status: active"; then
        run_priv ufw allow "${FINAL_PORT}/tcp" >/dev/null 2>&1 || true
    fi
fi

# Jalankan kedua service (wa-bot + agent-dashboard) dengan PM2
echo -e "\n${BLUE}Menjalankan wa-bot & agent-dashboard via PM2...${NC}"
pm2 startOrReload ecosystem.config.js --update-env
pm2 save || true

PUBLIC_IP=$(curl -fsSL --max-time 4 https://api.ipify.org 2>/dev/null || hostname -I | awk '{print $1}')
TOKEN_PATH="$HOME/.gemini/antigravity-cli/antigravity-oauth-token"

echo -e "\n${GREEN}======================================================${NC}"
echo -e "${GREEN}${BOLD}   INSTALASI SELESAI — BOT & DASHBOARD AKTIF!       ${NC}"
echo -e "${GREEN}======================================================${NC}"
echo -e "1. ${BOLD}Buka Web Ops Dashboard di Browser HP / Laptop:${NC}"
echo -e "   http://${PUBLIC_IP}:${FINAL_PORT}"
echo -e "   Peta Workflow Live: http://${PUBLIC_IP}:${FINAL_PORT}/task-map"
echo -e ""
echo -e "2. ${BOLD}Tautkan WhatsApp (Tanpa Ribet SSH):${NC}"
echo -e "   Di Web Dashboard > kartu WhatsApp Agent, masukkan nomor WA bot"
echo -e "   lalu klik Minta Pairing Code dan masukkan kode 8-digit di HP Anda."
echo -e ""
if [ ! -f "$TOKEN_PATH" ]; then
echo -e "3. ${BOLD}Login Akun Google AI (Sekali Saja):${NC}"
echo -e "   Ketik perintah ini di terminal lalu buka link Google di browser:"
echo -e "   agy"
echo -e ""
fi
echo -e "CLI Toolkit: ${BLUE}rhteaster status${NC} | ${BLUE}rhteaster doctor${NC} | ${BLUE}rhteaster pair${NC} | ${BLUE}rhteaster logs${NC}"
echo -e "======================================================\n"
