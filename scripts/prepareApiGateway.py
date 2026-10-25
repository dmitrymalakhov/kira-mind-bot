#!/usr/bin/env python3
"""Render a private nginx deployment without changing the server or handling API secrets."""
import argparse
import ipaddress
import os
from pathlib import Path
import re


ROOT = Path(__file__).resolve().parent.parent
TEMPLATES = ROOT / "scripts/ops/api-gateway"


def hostname(value):
    if (len(value) > 253 or "." not in value
            or not all(re.fullmatch(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?", label)
                       for label in value.split("."))):
        raise argparse.ArgumentTypeError("Нужен DNS hostname в нижнем регистре, без URL и пути")
    return value


def main():
    parser = argparse.ArgumentParser(description="Подготовить приватную конфигурацию HTTPS-шлюза API")
    parser.add_argument("--domain", required=True, type=hostname)
    parser.add_argument("--upstream-dns", required=True, type=hostname)
    parser.add_argument("--upstream-ip", required=True, type=ipaddress.IPv4Address)
    parser.add_argument("--output", type=Path, default=ROOT / "runtime-data/api-gateway")
    args = parser.parse_args()
    if not args.upstream_dns.endswith(".ts.net"):
        parser.error("upstream-dns должен быть полным именем Tailscale (.ts.net)")
    output = args.output.resolve()
    if not output.is_relative_to((ROOT / "runtime-data").resolve()):
        parser.error("Личные deployment-файлы должны находиться внутри runtime-data/")
    if output.exists() and any(output.iterdir()):
        parser.error("Выходной каталог не пуст; выбери новый каталог для повторной подготовки")
    replacements = {
        "@@DOMAIN@@": args.domain,
        "@@UPSTREAM_DNS@@": args.upstream_dns,
        "@@UPSTREAM_IP@@": str(args.upstream_ip),
    }
    files = {
        "00-kira-api-http.conf": "http.conf.template",
        "kira-api-http.conf": "http-site.conf.template",
        "kira-api-https.conf": "https-site.conf.template",
    }
    output.mkdir(parents=True, mode=0o700, exist_ok=True)
    output.chmod(0o700)
    for name, template in files.items():
        content = (TEMPLATES / template).read_text(encoding="utf-8")
        for key, value in replacements.items():
            content = content.replace(key, value)
        fd = os.open(output / name, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            stream.write(content)
    print("Подготовлены три приватных nginx-конфига. Установка: docs/public-api-gateway.md")


if __name__ == "__main__":
    main()
