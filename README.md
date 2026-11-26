# Personal Image Host

A small image-hosting service for a Debian 13 VPS, with a local MariaDB
database, an upload page and an image manager. An optional Cloudflare Worker
provides a private page for generating upload and management codes.

| Folder | What it does | Start here |
| --- | --- | --- |
| `imghost-vps/` | Runs the image host, local database, Nginx and phpMyAdmin | [VPS installation](imghost-vps/README.md) |
| `codegen-cf/` | Provides the optional Cloudflare Access-protected code generator | [Worker installation](codegen-cf/README.md) |

## Install in this order

1. Get a fresh Debian 13 VPS with root access, a domain and a Cloudflare account.
   The included guide uses Cloudflare DNS and origin certificates for HTTPS.
2. Follow the VPS guide to install the app and enable HTTPS. The usual public
   ports are **80** and **443**; the Node app and database stay local. Custom
   forwarded ports are also supported.
3. Generate a code over SSH and try uploading and managing an image.
4. If you want the browser code generator, follow the Worker guide. Deploy
   through GitHub and the Cloudflare dashboard, then protect it with Access.

Every `example.com` address in these files is a placeholder. Use your own image
domain, such as `images.your-domain.tld`, and a separate generator domain.
Configure the Worker domains in `codegen-cf/wrangler.jsonc`; no source edits
are needed. The VPS guide shows where its domain and optional generator URL go.

## Features

- Image uploads with single-use codes and optional custom links.
- Management login, gallery, bulk deletion and local phpMyAdmin access.
- Local MariaDB; no external database account is needed.
- Automatic startup after reboot and an updater that preserves settings/data.
- Optional private code generation; SSH commands remain available.

## Sharing and private files

This source copy contains no saved server configuration, session key, uploaded
images, dependency folders or generated caches. The installer creates fresh
database credentials and a session key on each new server. Test credentials
are deliberately fake and used only in isolated tests.

Keep your installed `config.json`, `.session-secret`, Worker secrets, private
keys, SQL backups and uploaded images private. Share this clean source folder
instead of copying a running installation. Git ignore rules help with Git;
they do not remove private files from a manually created ZIP or web upload.
