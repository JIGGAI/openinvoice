# Customer Time Tracker

Standalone local app for tracking time, customers/projects, invoices, invoice PDFs, and local company invoice branding.

## Requirements

- Node.js 20 or newer
- npm

## Install

```bash
cd ~/Sites/customer-time-tracker
npm install
```

## Run Locally

```bash
npm start
```

Open:

```text
http://localhost:8787
```

Use a different port:

```bash
PORT=8790 npm start
```

## Detached Local Run

Use this when you want the app to stay running after the terminal closes:

```bash
cd ~/Sites/customer-time-tracker
setsid bash -c 'exec env PORT=8787 node server.js' >/tmp/customer-time-tracker.log 2>&1 < /dev/null &
```

Check that it is running:

```bash
pgrep -af "node server.js"
curl -fsS http://127.0.0.1:8787/api/state
```

Stop it:

```bash
kill <pid>
```

## Deploy With systemd

Create a service file:

```bash
sudo tee /etc/systemd/system/customer-time-tracker.service >/dev/null <<'EOF'
[Unit]
Description=Customer Time Tracker
After=network.target

[Service]
Type=simple
WorkingDirectory=/home/control/Sites/customer-time-tracker
ExecStart=/usr/bin/env PORT=8787 node server.js
Restart=always
RestartSec=5
User=control
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
EOF
```

Start and enable it:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now customer-time-tracker
sudo systemctl status customer-time-tracker
```

View logs:

```bash
journalctl -u customer-time-tracker -f
```

Restart after updates:

```bash
sudo systemctl restart customer-time-tracker
```

## Data and Backups

All app data is stored locally in:

```text
data/time-tracker.json
```

Back up that file to preserve:

- customers and projects
- time entries
- invoice records
- paid/unpaid status
- company name, address, and logo data

Backup example:

```bash
cd ~/Sites/customer-time-tracker
cp data/time-tracker.json data/time-tracker.$(date -u +%Y%m%d-%H%M%S).json
```

## Updating

```bash
cd ~/Sites/customer-time-tracker
npm install
node --check server.js
node --check public/app.js
node --check public/invoice-edit.js
```

Then restart the running process or service.

## Useful URLs

```text
http://localhost:8787/
http://localhost:8787/#invoices
http://localhost:8787/#company
http://localhost:8787/api/export.csv
```

Invoice HTML and PDF exports use invoice IDs:

```text
http://localhost:8787/api/invoices/<invoiceId>.html
http://localhost:8787/api/invoices/<invoiceId>.pdf
```

## Rollback

Restore a known-good copy of the project files and data file, then restart the app:

```bash
cd ~/Sites/customer-time-tracker
node --check server.js
npm start
```
