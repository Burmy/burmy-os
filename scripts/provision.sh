#!/usr/bin/env bash
set -euo pipefail

# ─────────────────────────────────────────────────────────────────────────────
# Burmy VPS provisioning — run ONCE, as root, over the VPS provider's initial
# console/key-based SSH session (before Tailscale exists). Ubuntu/Debian
# (apt) assumed, matching Oracle Cloud's Ampere A1 Always Free default image
# — see docs/DEPLOYMENT.md for portability notes if a different provider is
# used instead.
#
# UNTESTED AGAINST A REAL VPS as of this commit — there is no Windows-hosted
# way to exercise ufw/tailscale/sshd changes against a real remote host
# locally. Reviewed carefully instead. Treat the first real run as the test.
#
# After this script finishes, SSH access moves to the Tailscale interface
# ONLY (step 5). Confirm `tailscale ssh burmy@<node>` (or plain
# `ssh burmy@<tailscale-ip>`) works BEFORE closing your current console
# session — your cloud provider's own console/recovery access is the
# fallback if something goes wrong, and this script does not touch it.
#
# TAILSCALE_AUTHKEY must be a FRESH, SHORT-LIVED, single-use key generated in
# the Tailscale admin console specifically for this node. Do not reuse an old
# key and do not keep this one anywhere after the script exits — a future
# re-provision means generating a new one-off key, not storing a reusable
# credential merely for that hypothetical (owner decision, M10).
#
#   TAILSCALE_AUTHKEY=tskey-auth-xxxxx ./scripts/provision.sh
# ─────────────────────────────────────────────────────────────────────────────

if [ "$(id -u)" -ne 0 ]; then
  echo "must run as root" >&2
  exit 1
fi

: "${TAILSCALE_AUTHKEY:?TAILSCALE_AUTHKEY must be set — a fresh, single-use key from the Tailscale admin console}"
APP_USER="${APP_USER:-burmy}"
APP_DIR="/home/${APP_USER}/burmy-os"

echo "== 1/8 update packages =="
apt-get update -y
apt-get upgrade -y

echo "== 2/8 install docker =="
if ! command -v docker >/dev/null 2>&1; then
  curl -fsSL https://get.docker.com | sh
fi

echo "== 3/8 install + configure ufw (default-deny inbound) =="
apt-get install -y ufw
ufw default deny incoming
ufw default allow outgoing
ufw --force enable

echo "== 4/8 install + join tailscale =="
if ! command -v tailscale >/dev/null 2>&1; then
  curl -fsSL https://tailscale.com/install.sh | sh
fi
# --ssh=false: plain OpenSSH over the tailscale interface is the chosen path
# (owner decision), not Tailscale's own SSH feature.
tailscale up --authkey="${TAILSCALE_AUTHKEY}" --ssh=false
ufw allow in on tailscale0 to any port 22 proto tcp

echo "== 5/8 harden sshd (key-only, no root login) =="
sed -i \
  -e 's/^#\?PasswordAuthentication.*/PasswordAuthentication no/' \
  -e 's/^#\?PermitRootLogin.*/PermitRootLogin no/' \
  /etc/ssh/sshd_config
systemctl restart ssh

echo "== 6/8 create app user =="
if ! id -u "${APP_USER}" >/dev/null 2>&1; then
  useradd --create-home --shell /bin/bash "${APP_USER}"
  usermod -aG docker "${APP_USER}"
fi

echo "== 7/8 app directory + secret-file placeholders =="
mkdir -p "${APP_DIR}"
for f in .env.postgres .env.database .env.app .env.tunnel .env.backup; do
  if [ ! -f "${APP_DIR}/${f}" ]; then
    : > "${APP_DIR}/${f}"
    chmod 600 "${APP_DIR}/${f}"
  fi
done
# /var/backups/burmy: where scripts/backup.sh writes the SHORT-LIVED
# plaintext dump before restic encrypts it and the EXIT trap deletes it.
mkdir -p /var/backups/burmy
chown -R "${APP_USER}:${APP_USER}" "${APP_DIR}" /var/backups/burmy
chmod 700 /var/backups/burmy

echo "== 8/8 systemd timers =="
mkdir -p /etc/systemd/system
cat <<'NOTE'
Unit files live in the repo under deploy/systemd/ — this step only prepares
the directories. Once the repo is cloned into the app directory (see the
remaining manual steps below), run:

  cp <app-dir>/deploy/systemd/*.service <app-dir>/deploy/systemd/*.timer /etc/systemd/system/
  systemctl daemon-reload
  systemctl enable --now burmy-backup.timer burmy-maintenance.timer \
                          burmy-restore-verify.timer burmy-check-host.timer
NOTE

cat <<EOF

Provisioning done. Remaining manual steps, IN ORDER:
  1. From your own machine: confirm \`ssh ${APP_USER}@<tailscale-ip>\` works —
     do this BEFORE closing this console session.
  2. Populate the five .env.* files under ${APP_DIR} (already 0600).
  3. git clone the repo into ${APP_DIR}.
  4. Install and enable the systemd timers (see above).
  5. Run scripts/deploy.sh from inside ${APP_DIR} for the first deploy.
EOF
