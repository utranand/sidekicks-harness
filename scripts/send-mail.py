#!/usr/bin/env python3
"""Send an email from the Sidekicks repo.

Configuration is read from the root Sidekicks project config (`.sidekicks/config.yaml`)
under a `mail_sender:` block — that file is git-ignored, so the App Password is never
committed. Environment variables (SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, MAIL_FROM)
override the config when set, so the same script also works in CI/secret-injected runs.

Transport is Python stdlib `smtplib` + `email` over STARTTLS (Gmail: smtp.gmail.com:587).
The only non-stdlib import is PyYAML, which lives in the repo-root `.venv` per CLAUDE.md —
run this with that interpreter:  $ROOT/.venv/bin/python scripts/send-mail.py …

Usage:
    send-mail.py --to a@b.com [--to c@d.com] --subject "Hi" --body "text"
    send-mail.py --to a@b.com --subject "Hi" --body-file note.txt
    send-mail.py --to a@b.com --subject "Hi" --body "text" --dry-run   # build only, no send
    send-mail.py --subject "Hi" --body "text"                           # uses default_recipient from config
    send-mail.py --subject "Hi" --body "text" --attach report.pdf       # attach files (repeatable)
    send-mail.py --subject "Hi" --body "text" --html-file body.html      # multipart: text + HTML alternative

When --html / --html-file is supplied, the message is sent as multipart/alternative: the
plain --body / --body-file becomes the text fallback and the HTML becomes the rich part that
modern clients render. Without it, the message stays plain text (unchanged behavior).

Exit codes: 0 = sent (server accepted), 2 = bad usage/config, 1 = send failed.
"""
import argparse
import mimetypes
import os
import smtplib
import ssl
import sys
from email.message import EmailMessage
from pathlib import Path

CONFIG_KEY = "mail_sender"
DEFAULTS = {"smtp_host": "smtp.gmail.com", "smtp_port": 587}


def repo_root(start: Path) -> Path:
    for parent in [start, *start.parents]:
        if (parent / ".sidekicks").is_dir():
            return parent
    return start


def load_config_via_cli(root: Path) -> dict | None:
    """The mail_sender block as `sidekicks config get` resolves it, or None if it cannot answer.

    THE CLI IS THE RESOLVER. Configuration is no longer one file per scope: mail_sender lives in
    .sidekicks/config/comms.yaml with its smtp_pass in the git-ignored comms.secret.yaml sibling, above
    the retired monolith. Asking the CLI keeps this script's answer identical to every other reader's,
    and it is the only path that still works once a scope's monolith has been retired.
    """
    import json
    import subprocess
    try:
        out = subprocess.run(
            ["node", str(root / "bin" / "sidekicks"), "config", "get", CONFIG_KEY,
             "--json", "--reveal"],
            capture_output=True, text=True, check=True,
        ).stdout
    except (subprocess.CalledProcessError, FileNotFoundError, OSError):
        return None
    try:
        payload = json.loads(out)
    except ValueError:
        return None
    block = payload.get("config")
    return block if isinstance(block, dict) else None


def load_config(config_path: Path) -> dict:
    """Read the mail_sender block from a config file; empty dict if absent."""
    if not config_path.exists():
        return {}
    try:
        import yaml
    except ImportError:
        sys.exit("error: PyYAML missing — run with the repo-root .venv interpreter "
                 "($ROOT/.venv/bin/python).")
    try:
        doc = yaml.safe_load(config_path.read_text()) or {}
    except Exception as e:
        sys.exit(f"error: could not parse {config_path}: {e}")
    block = doc.get(CONFIG_KEY) or {}
    if not isinstance(block, dict):
        sys.exit(f"error: '{CONFIG_KEY}' in {config_path} must be a mapping.")
    return block


def resolve_setting(key, cfg, env_name, default=None):
    """env var wins, then config.yaml, then default."""
    val = os.environ.get(env_name)
    if val is not None and val != "":
        return val
    if cfg.get(key) not in (None, ""):
        return cfg[key]
    return default


def main() -> int:
    ap = argparse.ArgumentParser(description="Send an email from the Sidekicks repo.")
    ap.add_argument("--to", action="append", default=[], metavar="ADDR",
                    help="recipient (repeatable; or comma-separated); omit to use default_recipient from config")
    ap.add_argument("--subject", default="(no subject)")
    ap.add_argument("--body", default=None, help="message body text (plain-text part / fallback)")
    ap.add_argument("--body-file", default=None, help="read plain-text body from this file")
    ap.add_argument("--html", default=None, help="HTML body (sent as a multipart/alternative rich part)")
    ap.add_argument("--html-file", default=None, help="read the HTML body from this file")
    ap.add_argument("--from", dest="mail_from", default=None, help="override sender")
    ap.add_argument("--attach", action="append", default=[], metavar="FILE",
                    help="attach a file to the message (repeatable)")
    ap.add_argument("--config", default=None, help="override config.yaml path")
    ap.add_argument("--dry-run", action="store_true",
                    help="build + validate the message and config, but do not connect/send")
    args = ap.parse_args()

    root = repo_root(Path(__file__).resolve().parent)
    # An explicit --config wins; otherwise the store answers, falling back to a direct read of the
    # legacy monolith for a copy running without the CLI.
    if args.config:
        config_path = Path(args.config)
        cfg = load_config(config_path)
    else:
        config_path = root / ".sidekicks" / "config.yaml"
        cfg = load_config_via_cli(root)
        if cfg is None:
            cfg = load_config(config_path)

    host = resolve_setting("smtp_host", cfg, "SMTP_HOST", DEFAULTS["smtp_host"])
    port = int(resolve_setting("smtp_port", cfg, "SMTP_PORT", DEFAULTS["smtp_port"]))
    user = resolve_setting("smtp_user", cfg, "SMTP_USER")
    password = resolve_setting("smtp_pass", cfg, "SMTP_PASS")
    mail_from = args.mail_from or resolve_setting("mail_from", cfg, "MAIL_FROM") or user

    # flatten comma-separated --to values; fall back to default_recipient from config
    recipients = [a.strip() for chunk in args.to for a in chunk.split(",") if a.strip()]
    if not recipients:
        default_recipient = cfg.get("default_recipient", "").strip()
        if default_recipient:
            recipients = [default_recipient]
        else:
            ap.error("at least one --to recipient is required (or set mail_sender.default_recipient in config)")

    if args.body_file:
        body = Path(args.body_file).read_text()
    elif args.body is not None:
        body = args.body
    else:
        body = ""

    if args.html_file:
        html = Path(args.html_file).read_text()
    elif args.html is not None:
        html = args.html
    else:
        html = None
    # a multipart/alternative needs a non-empty text fallback for clients that don't render HTML
    if html and not body:
        body = "This message is best viewed in an HTML-capable email client."

    missing = [n for n, v in (("smtp_user", user), ("smtp_pass", password),
                              ("mail_from", mail_from)) if not v]
    if missing:
        sys.exit("error: missing required setting(s): " + ", ".join(missing) +
                 f"\n  set them under '{CONFIG_KEY}:' in {config_path} "
                 "(or via SMTP_USER/SMTP_PASS/MAIL_FROM env vars).")

    # validate attachment paths before building the message
    attach_paths = []
    for raw in args.attach:
        p = Path(raw)
        if not p.exists():
            sys.exit(f"error: attachment not found: {raw}")
        if not p.is_file():
            sys.exit(f"error: attachment path is not a file: {raw}")
        attach_paths.append(p)

    msg = EmailMessage()
    msg["From"] = mail_from
    msg["To"] = ", ".join(recipients)
    msg["Subject"] = args.subject
    msg.set_content(body)
    if html:
        msg.add_alternative(html, subtype="html")

    for p in attach_paths:
        mime_type, _ = mimetypes.guess_type(str(p))
        if mime_type:
            maintype, subtype = mime_type.split("/", 1)
        else:
            maintype, subtype = "application", "octet-stream"
        msg.add_attachment(p.read_bytes(), maintype=maintype, subtype=subtype, filename=p.name)

    if args.dry_run:
        print(f"[dry-run] would send via {host}:{port} as {user}")
        print(f"[dry-run] From: {mail_from}  To: {', '.join(recipients)}  "
              f"Subject: {args.subject}")
        print(f"[dry-run] attachments: {len(attach_paths)}"
              + (f" ({', '.join(p.name for p in attach_paths)})" if attach_paths else ""))
        print(f"[dry-run] format: {'multipart/alternative (text + HTML)' if html else 'text/plain'}"
              + (f"  html={len(html)} chars" if html else ""))
        return 0

    try:
        with smtplib.SMTP(host, port, timeout=30) as smtp:
            smtp.ehlo()
            smtp.starttls(context=ssl.create_default_context())
            smtp.ehlo()
            smtp.login(user, password)
            smtp.send_message(msg)
    except smtplib.SMTPAuthenticationError:
        sys.exit("error: SMTP authentication failed — for Gmail, smtp_pass must be a 16-char "
                 "App Password (not your normal password), and the account must have 2-Step "
                 "Verification enabled.")
    except (smtplib.SMTPException, OSError) as e:
        sys.exit(f"error: send failed: {e}")

    print(f"sent: '{args.subject}' -> {', '.join(recipients)} (via {host}:{port})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
