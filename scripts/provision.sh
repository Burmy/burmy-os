#!/usr/bin/env bash
set -euo pipefail

# ─────────────────────────────────────────────────────────────────────────────
# Burmy VPS provisioning — run ONCE, as root, over the VPS provider's initial
# console/key-based SSH session. Ubuntu/Debian (apt) assumed, matching
# Oracle Cloud's Ampere A1 Always Free default image — see
# docs/DEPLOYMENT.md for portability notes if a different provider is used.
#
# SIMPLIFIED SCOPE (owner decision): ordinary SSH, not a VPN mesh. No
# Tailscale, no private-network service whose only purpose is reaching SSH —
# key-only authentication on the public SSH port is judged sufficient for a
# single-owner personal deployment, and adding infrastructure solely to
# protect infrastructure was explicitly rejected. If a concrete need for a
# VPN-gated admin path shows up later, that is a deliberate follow-up
# decision, not a default to reach for now.
#
# UNTESTED AGAINST A REAL VPS as of this commit — there is no Windows-hosted
# way to exercise ufw/sshd changes against a real remote host locally.
# Reviewed carefully instead. Treat the first real run as the test.
#
# After this script finishes, confirm key-based SSH still works BEFORE
# closing your current console session — your cloud provider's own
# console/recovery access is the fallback if something goes wrong, and this
# script does not touch it.
# ─────────────────────────────────────────────────────────────────────────────

if [ "$(id -u)" -ne 0 ]; then
  echo "must run as root" >&2
  exit 1
fi

APP_USER="${APP_USER:-burmy}"
APP_DIR="/home/${APP_USER}/burmy-os"
SSH_PORT="${SSH_PORT:-22}"

echo "== 1/7 update packages =="
apt-get update -y
apt-get upgrade -y

echo "== 2/7 install docker =="
if ! command -v docker >/dev/null 2>&1; then
  curl -fsSL https://get.docker.com | sh
fi

echo "== 3/7 configure ufw (default-deny inbound; allow only SSH) =="
# Burmy-OS itself and Postgres are never exposed here at all — the app is
# reached exclusively through the outbound-only Cloudflare Tunnel, which
# needs no inbound firewall rule of its own (it dials OUT). SSH is the ONE
# admin path, so it is the ONE inbound rule.
apt-get install -y ufw
ufw default deny incoming
ufw default allow outgoing
ufw allow "${SSH_PORT}/tcp"
ufw --force enable

echo "== 4/7 harden sshd (key-only, no root login) =="
sed -i \
  -e 's/^#\?PasswordAuthentication.*/PasswordAuthentication no/' \
  -e 's/^#\?PermitRootLogin.*/PermitRootLogin no/' \
  /etc/ssh/sshd_config
systemctl restart ssh

echo "== 5/7 create app user =="
if ! id -u "${APP_USER}" >/dev/null 2>&1; then
  useradd --create-home --shell /bin/bash "${APP_USER}"
  usermod -aG docker "${APP_USER}"
fi
# Reuse the root session's authorized key(s) for the app user too, so key
# access survives PermitRootLogin being turned off above. If you provisioned
# with a different key per user, add it manually instead.
if [ -f /root/.ssh/authorized_keys ] && [ ! -f "/home/${APP_USER}/.ssh/authorized_keys" ]; then
  mkdir -p "/home/${APP_USER}/.ssh"
  cp /root/.ssh/authorized_keys "/home/${APP_USER}/.ssh/authorized_keys"
  chmod 700 "/home/${APP_USER}/.ssh"
  chmod 600 "/home/${APP_USER}/.ssh/authorized_keys"
  chown -R "${APP_USER}:${APP_USER}" "/home/${APP_USER}/.ssh"
fi

echo "== 6/7 app directory + secret-file placeholders =="
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

echo "== 7/7 systemd timers =="
# Only the REQUIRED timers are enabled by default: nightly backup, weekly
# repository maintenance (forget --prune + check — a "reasonable retention
# policy," not the thing being deferred). Automated weekly restore
# verification and the daily host check are OPTIONAL for V1 (owner
# decision) — their unit files are still shipped in deploy/systemd/, and
# the commands to opt into them are printed below, but this script does not
# enable them itself.
mkdir -p /etc/systemd/system
cat <<'NOTE'
Unit files live in the repo under deploy/systemd/ — this step only prepares
the directories. Once the repo is cloned into the app directory (see the
remaining manual steps below), run:

  cp <app-dir>/deploy/systemd/burmy-backup.* <app-dir>/deploy/systemd/burmy-maintenance.* \
     /etc/systemd/system/
  systemctl daemon-reload
  systemctl enable --now burmy-backup.timer burmy-maintenance.timer

OPTIONAL, not required for V1 — automated weekly restore verification and a
daily host check. Enable only if you want them:

  cp <app-dir>/deploy/systemd/burmy-restore-verify.* <app-dir>/deploy/systemd/burmy-check-host.* \
     /etc/systemd/system/
  systemctl daemon-reload
  systemctl enable --now burmy-restore-verify.timer burmy-check-host.timer
NOTE

cat <<EOF

Provisioning done. Remaining manual steps, IN ORDER:
  1. From your own machine: confirm \`ssh -p ${SSH_PORT} ${APP_USER}@<vps-ip>\` still works —
     do this BEFORE closing this console session.
  2. Populate the five .env.* files under ${APP_DIR} (already 0600).
  3. git clone the repo into ${APP_DIR}.
  4. Install and enable the systemd timers (see above — backup + maintenance
     are the two that matter for V1).
  5. Run scripts/deploy.sh from inside ${APP_DIR} for the first deploy.
EOF
