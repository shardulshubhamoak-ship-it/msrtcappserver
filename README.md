# MSRTC ST Bus Depot & QR App

Offline-first web app for MSRTC depots and conductors. Conductors create a **QR code** for each bus, the depot **scans** it to register the bus, and the app **announces** it in **Marathi, Hindi and English**. Everything the app stores is saved to **`db.json`** by the included server.

## Files (keep all five in one folder)

| File | What it is |
|---|---|
| `index.html` | The whole app (screens, face biometrics and models, help training). Edit this file and refresh the browser to change the app. |
| `server.js` | The server. Serves the app over **HTTP and HTTPS** and saves all data to `db.json`. No extra packages needed. |
| `db.json` | The database. Every account, QR code, register entry, notice and audit log is saved here. |
| `package.json` | Project file. Lets you start the server with `npm start`. |
| `README.md` | This guide. |

## Requirements

- [Node.js](https://nodejs.org) **16 or newer**. Nothing else to install (no `npm install` needed).

## Quick start

1. Put the five files in one folder.
2. Open a terminal in that folder and run:

   ```
   node server.js
   ```

   (or `npm start`)
3. The console prints the addresses to use. The app opens in your browser the first time.

The server restarts itself if it crashes. Press **Ctrl+C** to stop it for real.

## Opening the app

| Where | Address | Notes |
|---|---|---|
| This computer | `http://localhost:8080` | Camera works on `localhost`. |
| Phones / other devices | `https://192.168.x.x:8443` (the "Other devices" address printed in the console) | Must be on the same Wi-Fi. |

- A phone can only use the **camera** (QR scan and face scan) on an `https://` address. If you type the `http://...:8080` address on a phone, the server sends you to the HTTPS one.
- The HTTPS certificate is created automatically and is **self-signed**, so the first time a phone opens it a warning appears. Tap **Advanced -> Proceed** (once per phone).
- The certificate is stored in the `certs` folder. It is renewed automatically if the computer's Wi-Fi address changes. To use your own certificate, put `cert.pem` and `key.pem` in `certs`.

## How data is saved (`db.json`)

- Open the app **from the server address** (above). Every change - new account, QR code, bus scan, notice, platform edit, audit log - is saved to `db.json` about a second later. The "Online - Syncing" badge at the top shows it is connected.
- If you open `index.html` directly as a file, nothing reaches `db.json`.
- The app also keeps a copy on each device, so it keeps working **offline**. Data entered offline is sent to `db.json` automatically when the server is reachable again.
- Changes made on one device appear on the others after they sync. Deleting an account also removes it from `db.json`.
- `db.json` holds these lists: `users`, `qrCodes`, `depotRegister`, `notices`, `auditLogs`. The file shipped with the app contains one sample staff account and one sample notice.

**Backup:** copy `db.json`. **Restore or move to another computer:** stop the server, put the saved `db.json` next to `server.js`, start the server.

**Keep `db.json` private.** It contains hashed passwords and face data. Do not email or post it.

## Using the app

- **Help button** (red, bottom right): step-by-step training in English, Marathi and Hindi for everyone, staff and depot admins, plus common questions.
- **Staff / Conductor:** create a bus QR, view saved QR codes, change a platform number, read the depot notice board.
- **Depot Admin:**
  - Scan bus QR codes and register them.
  - **See All Register History:** pick a date to see every bus registered that day (export to Excel, announce any row).
  - **Announcements:** pick any register entry, then **Replay Announcement**.
  - Create depot QR codes, publish notices, see where a bus was last registered, view audit logs.
- **Face biometric:** required when **creating** any account (Staff or Depot) and when **logging in to the Depot console**. Staff login uses username and password only.

## Settings (optional)

Set as environment variables before starting.

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `8080` | HTTP port |
| `HTTPS_PORT` | `8443` | HTTPS port |
| `HTTPS` | on | `HTTPS=0` turns HTTPS off |
| `HOST` | `0.0.0.0` | Network interface to listen on |
| `DATA_FILE` | `./db.json` | Where all data is saved |
| `APP_FILE` | `./index.html` | App file to serve |
| `CERT_FILE`, `KEY_FILE` | `./certs/...` | Your own TLS certificate and key |
| `NO_SUPERVISOR` | off | `NO_SUPERVISOR=1` disables auto-restart |
| `NO_BROWSER` | off | `NO_BROWSER=1` stops the browser opening on first start |

Windows examples: Command Prompt `set PORT=9000 && node server.js`; PowerShell `$env:PORT=9000; node server.js`.

**Email OTP (optional):** the server can email one-time codes. Set the `SMTP_HOST`, `SMTP_USER`, `SMTP_PASS` (and optionally `SMTP_FROM`) variables, or edit the `DEPOT_GMAIL` block near the top of `server.js` with each depot's Gmail App Password. Without this, codes are only printed in the server console (test mode). See the comments at the top of `server.js` for details.

## Troubleshooting

| Problem | Fix |
|---|---|
| Camera does not start on a phone | Use the `https://` address, allow camera permission, close other apps using the camera. |
| Nothing saves to `db.json` | Open the app from the server address, not from the file. Check the console for errors. |
| "Port already in use" | Another copy is running. Close it, or set `PORT` / `HTTPS_PORT` to free ports. |
| Phone cannot reach the server | Same Wi-Fi? Allow Node.js through the computer's firewall for ports 8080 and 8443. |
| Face scan will not verify | Good light, face inside the oval, remove cap or mask, then follow the on-screen movement instruction. |
| Announcement has no sound | Turn up the volume and install Marathi / Hindi text-to-speech voices on the phone. |
