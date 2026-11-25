# Private demo on one EC2 instance

Use one Linux EC2 instance with Docker Engine, Docker Compose 2.17 or later, and an EBS-backed Docker data directory. Use a network whose public IPv4 address you control. Anyone sharing that public IP can use the two demo accounts and the development mailbox. The gateway applies this restriction to the entire site, including API calls and file downloads.

## First deployment

1. Point a DNS A record directly at the instance's stable public IPv4 address. Allow inbound TCP 80 and 443 for automatic certificate issuance and renewal. Restrict SSH to your own IP if you use SSH. Leave 3001 and 5432 closed. This configuration expects browsers to connect directly to the instance over IPv4.
2. Copy this branch to the instance. For example, from your workstation, replace `ubuntu@YOUR_HOST` with your SSH destination:

   ```sh
   git archive aws-hosting | ssh ubuntu@YOUR_HOST 'mkdir -p ~/collabboard && tar -x -C ~/collabboard'
   ```

3. On the instance, prepare the private settings. Enter your DNS hostname, your **browser network's** public IPv4 address (without `/32`), and a new database password. The example is intentionally empty. Generate the password with `openssl rand -hex 32` and retain it for subsequent deployments.

   ```sh
   cd ~/collabboard/infra/aws
   test -e .env || install -m 600 .env.example .env
   ${EDITOR:-vi} .env
   docker compose config --quiet
   docker compose up --build --wait -d
   docker compose ps
   ```

   Compose builds the web assets and Node API, starts PostgreSQL, applies pending migrations and seeds Alex and Jamie before serving API traffic. Rerunning the startup command preserves the database and accounts. Caddy serves the built web app and proxies same-origin API requests, including the live event stream. The API listens on the gateway's shared loopback interface. The only published ports are 80 and 443.

## Check the two-account workflow

1. From the allowed network, open `https://YOUR_DOMAIN/api/health/ready` and confirm `{"status":"ready"}`. Open the site in a normal browser window as Alex and in a private window or separate browser profile as Jamie.
2. As Alex, create a project and invite `jamie@example.com` as Editor. Open the invitation in Jamie's window and accept it. Assign a task to Jamie, then move it as Jamie and watch Alex's board update.
3. Upload a small attachment. On the instance run `docker compose restart api`. Refresh both windows and confirm the project and attachment are still accessible.
4. Open the site and `/api/auth/local-identities` from a different public IP, for example over mobile data with Wi-Fi off. Both should return HTTP 403. When your own IP changes, update `DEMO_IPV4` in `.env` and run `docker compose up -d --wait`.

## Operation

Run Compose commands from `infra/aws`. Inspect startup with `docker compose logs --tail=100 gateway api postgres`. Keep the same Compose project name and volumes across upgrades. Keep `.env` private. Use `docker compose down` to stop the demo and retain data. Adding `-v` deletes the volumes.

Before an upgrade, stop the stack with `docker compose stop`, take an EBS snapshot of the volume containing Docker's data and save the environment settings, then start the stack again. PostgreSQL holds the business data. The API's separate state volume holds SQLite sessions, attachments and their signing key. The gateway volume holds certificates. To recover, restore the data volume and matching application revision and settings before starting Compose.

The gateway uses the socket peer's IP. Keep DNS pointed directly at EC2. [Caddy remote IP matching](https://caddyserver.com/docs/caddyfile/matchers#remote-ip) and [automatic HTTPS prerequisites](https://caddyserver.com/docs/automatic-https).
