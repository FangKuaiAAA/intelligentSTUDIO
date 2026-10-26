"""生成 Office 加载项本地桥的自签名证书（PEM）。

为什么单独成一个文件，而不是塞进 PowerShell 的 here-string：
Windows PowerShell 5.1 对 here-string 结束符的位置极其挑剔（必须顶格），
而且会按 ANSI 读 .ps1，中文字符串极易把引号吃掉、整段脚本解析失败。
把 Python 代码放进 .py 里，编码与缩进都由 Python 自己负责。

输出：%APPDATA%\\Dony\\office-bridge\\cert.pem 与 key.pem
退出码：0 成功 / 3 缺少 cryptography 包 / 1 其它失败
"""
from __future__ import annotations

import datetime
import ipaddress
import os
import sys

CERT_DIR = os.environ.get("OFFICE_CERT_DIR") or os.path.join(
    os.environ.get("APPDATA") or os.path.expanduser("~"), "Dony", "office-bridge")
CERT_FILE = os.path.join(CERT_DIR, "cert.pem")
KEY_FILE = os.path.join(CERT_DIR, "key.pem")
VALID_DAYS = 825


def main() -> int:
    try:
        from cryptography import x509
        from cryptography.hazmat.primitives import hashes, serialization
        from cryptography.hazmat.primitives.asymmetric import rsa
        from cryptography.x509.oid import NameOID
    except ImportError:
        print("[cert] 缺少 cryptography：请先执行  python -m pip install cryptography")
        return 3

    os.makedirs(CERT_DIR, exist_ok=True)
    if os.path.exists(CERT_FILE) and os.path.exists(KEY_FILE):
        print(f"[cert] 已存在，跳过：{CERT_DIR}")
        return 0

    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "localhost")])
    now = datetime.datetime.now(datetime.timezone.utc)

    cert = (
        x509.CertificateBuilder()
        .subject_name(name)
        .issuer_name(name)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - datetime.timedelta(days=1))
        .not_valid_after(now + datetime.timedelta(days=VALID_DAYS))
        .add_extension(
            x509.SubjectAlternativeName(
                [
                    x509.DNSName("localhost"),
                    x509.IPAddress(ipaddress.ip_address("127.0.0.1")),
                ]
            ),
            critical=False,
        )
        .add_extension(x509.BasicConstraints(ca=True, path_length=None), critical=True)
        .sign(key, hashes.SHA256())
    )

    with open(CERT_FILE, "wb") as f:
        f.write(cert.public_bytes(serialization.Encoding.PEM))
    with open(KEY_FILE, "wb") as f:
        f.write(
            key.private_bytes(
                serialization.Encoding.PEM,
                serialization.PrivateFormat.PKCS8,
                serialization.NoEncryption(),
            )
        )

    print(f"[cert] 已生成：{CERT_FILE}")
    print(f"[cert] 私钥：  {KEY_FILE}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
