#!/usr/bin/env bash
set -e

echo "Installing Chrome system dependencies..."
apt-get update -y
apt-get install -y \
  libatk1.0-0 \
  libatk-bridge2.0-0 \
  libcups2 \
  libdrm2 \
  libgbm1 \
  libgtk-3-0 \
  libnspr4 \
  libnss3 \
  libxss1 \
  libxtst6 \
  xdg-utils \
  libxcomposite1 \
  libxdamage1 \
  libxfixes3 \
  libxrandr2 \
  ca-certificates \
  fonts-liberation \
  libasound2t64

echo "Done. Restarting PM2 app..."
pm2 restart triarc-whatsapp-bot
pm2 logs triarc-whatsapp-bot --lines 20
