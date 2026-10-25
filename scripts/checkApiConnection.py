#!/usr/bin/env python3
"""Read-only connection check for a private Kira API client configuration."""
import argparse
import json
import pathlib
import shutil
import subprocess
import sys
import urllib.parse


def main():
    parser = argparse.ArgumentParser(description="Проверить подключение к Kira API без AI-запросов")
    parser.add_argument("--config", type=pathlib.Path,
                        default=pathlib.Path(__file__).with_name("connection.json"))
    args = parser.parse_args()
    try:
        config = json.loads(args.config.read_text(encoding="utf-8"))
        base_url = config["baseUrl"].rstrip("/")
        token = config["token"]
        url = urllib.parse.urlsplit(base_url)
        if (url.scheme != "https" or not url.hostname or url.username or url.password
                or url.query or url.fragment or not url.path.endswith("/api/v1")
                or not isinstance(token, str) or len(token) < 32):
            raise ValueError("invalid connection configuration")
        # Use the system TLS stack on macOS; the token never appears in process arguments.
        curl = "/usr/bin/curl" if pathlib.Path("/usr/bin/curl").is_file() else shutil.which("curl")
        if not curl:
            print("Для проверки нужен curl.", file=sys.stderr)
            return 1
        curl_config = "url = " + json.dumps(base_url + "/status") + "\n"
        curl_config += "header = " + json.dumps("Authorization: Bearer " + token) + "\n"
        certificate, key = config.get("clientCertificate"), config.get("clientKey")
        if bool(certificate) != bool(key):
            raise ValueError("both clientCertificate and clientKey are required")
        if certificate:
            for option, filename in (("cert", certificate), ("key", key)):
                path = args.config.resolve().parent / filename
                if not path.is_file():
                    raise ValueError("missing client TLS file")
                curl_config += option + " = " + json.dumps(str(path)) + "\n"
        result = subprocess.run([
            curl, "--disable", "--silent", "--show-error", "--connect-timeout", "10", "--max-time", "20",
            "--proto", "=https", "--config", "-", "--write-out", "\n%{http_code}",
        ], input=curl_config, capture_output=True, text=True, timeout=25)
        if result.returncode:
            print("Нет HTTPS-соединения. Проверь адрес, сеть и клиентский TLS-сертификат; для приватного адреса также Tailscale.", file=sys.stderr)
            return 1
        body, code = result.stdout.rsplit("\n", 1)
        if code != "200":
            print("API вернул HTTP " + code
                  + (". Проверь токен." if code == "401" else ". Проверь доступность API."), file=sys.stderr)
            return 1
        status = json.loads(body)
        if status.get("ok") is not True or status.get("apiVersion") != "v1":
            raise ValueError("unexpected API status")
        print("Подключение успешно: HTTPS, токен и Kira API v1 работают.")
        print("Канал фоновых уведомлений: " + str(status.get("notificationsChannel", "telegram")))
        return 0
    except subprocess.TimeoutExpired:
        print("Время ожидания HTTPS-соединения истекло. Проверь сеть и доступ к серверу.", file=sys.stderr)
    except (OSError, ValueError, KeyError, TypeError):
        print("Не удалось прочитать конфигурацию или ответ API. Проверь connection.json.", file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main())
