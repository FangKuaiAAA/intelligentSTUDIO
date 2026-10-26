"""联网工具：网页搜索（必应为主、百度兜底）与网页正文读取。

只用国内可直连的引擎（cn.bing.com / baidu.com）。原来的实现抓的是 DuckDuckGo，
国内网络下连接必然超时（ConnectTimeout），工具每次都失败。
"""
import asyncio
import html as html_mod
import json
import os
import re
from typing import Any, Dict, List, Optional, Tuple
from urllib.parse import urljoin

import httpx

from .base import ToolResult, tool

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36")
_HEADERS = {
    "User-Agent": UA,
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
}
TIMEOUT = 15.0
CONNECT_TIMEOUT = 6.0                 # 连接阶段短超时：国外站点不可达时快速失败，不白等
MAX_PAGE_BYTES = 2 * 1024 * 1024      # 单页最多读取 2MB，防止超大页面卡住
SEARCH_ENGINE = os.getenv("AGENT_SEARCH_ENGINE", "auto").lower()   # auto | bing | baidu
# 百度结果里的广告/推荐位域名
_AD_HOSTS = ("nourl.ubs.baidu.com", "recommend_list.baidu.com", "baidu.com/link")


# ---------- 通用：编码与文本清洗 ----------
def _decode(raw: bytes, declared: Optional[str] = None) -> str:
    """按「响应头 charset > 页面 meta charset > utf-8 > gb18030」解码（国内站点常见 GBK）。"""
    if declared:
        try:
            return raw.decode(declared, errors="replace")
        except LookupError:
            pass
    m = re.search(rb'charset=["\']?\s*([\w\-]+)', raw[:4096], re.I)
    if m:
        try:
            return raw.decode(m.group(1).decode("ascii", errors="ignore"), errors="replace")
        except LookupError:
            pass
    for enc in ("utf-8", "gb18030"):
        try:
            return raw.decode(enc)
        except UnicodeDecodeError:
            continue
    return raw.decode("utf-8", errors="replace")


_TAG_RE = re.compile(r"<[^>]+>")
_BLOCK_TAGS = "p|div|br|li|tr|td|h[1-6]|section|article|table|ul|ol|dl|dt|dd|blockquote|pre|hr|figure"


def _clean_text(fragment: str) -> str:
    """去掉标签、反转义实体、压缩空白。"""
    fragment = re.sub(r"<!--.*?-->", " ", fragment, flags=re.S)
    fragment = _TAG_RE.sub("", fragment)
    fragment = html_mod.unescape(fragment)
    return re.sub(r"[\s\u00a0]+", " ", fragment).strip()


def _html_to_text(page: str) -> str:
    """网页 HTML → 可读纯文本（丢弃脚本/样式，块级标签转换行）。"""
    page = re.sub(r"(?is)<(script|style|noscript|svg|iframe|template|head)[^>]*>.*?</\1>",
                  " ", page)
    page = re.sub(r"(?is)<!--.*?-->", " ", page)
    page = re.sub(r"(?is)<br\s*/?>", "\n", page)
    page = re.sub(rf"(?is)</?(?:{_BLOCK_TAGS})[^>]*>", "\n", page)
    page = _TAG_RE.sub("", page)
    page = html_mod.unescape(page)
    lines: List[str] = []
    blank = True
    for raw in page.splitlines():
        line = re.sub(r"[ \t\u00a0]+", " ", raw).strip()
        if line:
            lines.append(line)
            blank = False
        elif not blank:
            lines.append("")
            blank = True
    return "\n".join(lines).strip()


def _page_title(page: str) -> str:
    m = re.search(r"(?is)<title[^>]*>(.*?)</title>", page)
    if not m:
        return ""
    return _clean_text(m.group(1))[:100]


def _normalize_url(url: str) -> str:
    """补全协议并拒绝非 http(s)（javascript:/file: 等）。"""
    url = (url or "").strip().strip('"\'')
    if not url:
        raise ValueError("未指定网址")
    if url.startswith("//"):
        url = "https:" + url
    elif not re.match(r"^[a-zA-Z][a-zA-Z0-9+.\-]*:", url):
        url = "https://" + url
    if not url.lower().startswith(("http://", "https://")):
        raise ValueError(f"不支持的网址协议：{url.split(':', 1)[0]}")
    return url


async def _fetch(url: str) -> Tuple[str, str, bytes, Optional[str]]:
    """抓取网页，返回 (最终URL, content-type, 原始字节, 声明的编码)。"""
    async with httpx.AsyncClient(timeout=httpx.Timeout(TIMEOUT, connect=CONNECT_TIMEOUT),
                                 follow_redirects=True, headers=_HEADERS) as client:
        async with client.stream("GET", url) as resp:
            resp.raise_for_status()
            final_url = str(resp.url)
            ctype = resp.headers.get("content-type", "")
            buf = bytearray()
            async for chunk in resp.aiter_bytes():
                buf += chunk
                if len(buf) >= MAX_PAGE_BYTES:
                    break
            return final_url, ctype, bytes(buf), resp.charset_encoding


# ---------- 必应 ----------
def _bing_real_url(url: str) -> str:
    """解析必应 /ck/a 跳转链（u=a1<base64url>）为真实地址。"""
    if "bing.com/ck/a" in url:
        m = re.search(r"[?&]u=a1([^&]+)", url)
        if m:
            import base64
            token = m.group(1) + "=" * (-len(m.group(1)) % 4)
            try:
                return base64.urlsafe_b64decode(token).decode("utf-8", errors="replace")
            except Exception:
                pass
    if url.startswith("/"):
        return urljoin("https://cn.bing.com", url)
    return url


def _parse_bing(page: str, count: int) -> List[Dict[str, str]]:
    results: List[Dict[str, str]] = []
    for block in re.split(r'(?=<li class="b_algo")', page)[1:]:
        m = re.search(r'<h2[^>]*>\s*<a[^>]+href="([^"]+)"[^>]*>(.*?)</a>', block, re.S)
        if not m:
            continue
        url = _bing_real_url(html_mod.unescape(m.group(1)))
        title = _clean_text(m.group(2))
        if not url.startswith("http") or not title:
            continue
        snip = ""
        for pat in (r'<p[^>]*class="[^"]*b_lineclamp[^"]*"[^>]*>(.*?)</p>',
                    r'<div[^>]*class="[^"]*b_caption[^"]*"[^>]*>.*?<p[^>]*>(.*?)</p>',
                    r'<p[^>]*>(.*?)</p>'):
            ms = re.search(pat, block, re.S)
            if ms and len(_clean_text(ms.group(1))) > 15:
                snip = _clean_text(ms.group(1))
                break
        results.append({"title": title, "url": url, "snippet": snip[:300]})
        if len(results) >= count:
            break
    return results


async def _bing_search(query: str, count: int) -> List[Dict[str, str]]:
    async with httpx.AsyncClient(timeout=TIMEOUT, follow_redirects=True,
                                 headers=_HEADERS) as client:
        resp = await client.get("https://cn.bing.com/search",
                                params={"q": query, "ensearch": "0", "setlang": "zh-CN"})
    resp.raise_for_status()
    return _parse_bing(_decode(resp.content, resp.charset_encoding), count)


# ---------- 百度（兜底） ----------
def _parse_baidu(page: str, count: int) -> List[Dict[str, str]]:
    results: List[Dict[str, str]] = []
    for seg in re.split(r'(?=<div[^>]*class="result[^"]*c-container[^"]*")', page)[1:]:
        if ">广告<" in seg or "广告</" in seg:
            continue
        m = re.search(r"\bmu=\"([^\"]+)\"", seg)
        mu = html_mod.unescape(m.group(1)) if m else ""
        if not mu or any(h in mu for h in _AD_HOSTS):
            continue
        h3 = re.search(r"(?is)<h3[^>]*>(.*?)</h3>", seg)
        title = _clean_text(h3.group(1)) if h3 else ""
        if not title:
            continue
        snip = ""
        ma = re.search(r'(?is)<div[^>]*class="[^"]*c-abstract[^"]*"[^>]*>(.*?)</div>', seg)
        if ma:
            snip = _clean_text(ma.group(1))
        else:
            # 结构化卡片没有 c-abstract：取整段文本中标题之后的部分
            plain = _clean_text(re.sub(r"(?is)<style.*?</style>", " ", seg))
            idx = plain.find(title)
            snip = plain[idx + len(title):].strip() if idx >= 0 else plain
        results.append({"title": title, "url": mu, "snippet": snip[:300]})
        if len(results) >= count:
            break
    return results


async def _baidu_search(query: str, count: int) -> List[Dict[str, str]]:
    async with httpx.AsyncClient(timeout=TIMEOUT, follow_redirects=True,
                                 headers=_HEADERS) as client:
        # 先访问首页拿 BAIDUID cookie，否则 /s 稳定返回「百度安全验证」页
        await client.get("https://www.baidu.com/")
        resp = await client.get("https://www.baidu.com/s",
                                params={"wd": query, "ie": "utf-8"},
                                headers={"Referer": "https://www.baidu.com/"})
    resp.raise_for_status()
    page = _decode(resp.content, resp.charset_encoding)
    if "百度安全验证" in page:
        raise RuntimeError("触发百度安全验证")
    return _parse_baidu(page, count)


# ---------- 工具 ----------
@tool("web_search", "网络搜索",
      "用搜索引擎（必应，失败时自动改百度）联网搜索，返回结果标题、链接和摘要。"
      "需要网页正文时，再对结果链接调用 web_fetch。",
      {"query": {"type": "string", "description": "搜索关键词", "required": True},
       "count": {"type": "integer", "description": "返回条数，默认6，最多10"},
       "engine": {"type": "string", "enum": ["auto", "bing", "baidu"],
                  "description": "搜索引擎，默认 auto（必应优先）"}})
async def web_search(args: Dict[str, Any], ctx) -> ToolResult:
    query = (args.get("query") or "").strip()
    if not query:
        return ToolResult("未指定搜索关键词", ok=False)
    count = max(1, min(int(args.get("count") or 6), 10))
    engine = (args.get("engine") or SEARCH_ENGINE or "auto").lower()
    order = ["bing", "baidu"] if engine == "auto" else [engine]
    label = {"bing": "必应", "baidu": "百度"}

    results: List[Dict[str, str]] = []
    errors: List[str] = []
    used = ""
    for name in order:
        try:
            found = await (_bing_search if name == "bing" else _baidu_search)(query, count)
        except Exception as e:
            errors.append(f"{label[name]}：{type(e).__name__} {e}".strip())
            continue
        if found:
            results, used = found, name
            break
        errors.append(f"{label[name]}：无结果")

    if not results:
        return ToolResult(f"搜索「{query}」失败。\n" + "\n".join(errors), ok=False)

    lines = []
    for i, r in enumerate(results, 1):
        item = f"{i}. {r['title']}\n   {r['url']}"
        if r["snippet"]:
            item += f"\n   {r['snippet']}"
        lines.append(item)
    # 搜索是过程、不是成果：不发卡片
    text = (f"「{query}」的搜索结果（来源：{label[used]}，共 {len(results)} 条）：\n"
            + "\n".join(lines) + "\n\n如需某条结果的正文，用 web_fetch 读取对应链接。")
    return ToolResult(text)


@tool("web_fetch", "读取网页",
      "读取网页正文（自动去除脚本/样式/导航噪声，返回纯文本）。url 可传搜索结果里的链接。"
      "max_chars 限制返回正文长度，默认 5000。国外站点（如 google、huggingface）在国内通常无法访问，"
      "优先读国内来源。",
      {"url": {"type": "string", "description": "网页地址", "required": True},
       "max_chars": {"type": "integer", "description": "最多返回正文字符数，默认5000"}})
async def web_fetch(args: Dict[str, Any], ctx) -> ToolResult:
    try:
        url = _normalize_url(args.get("url") or "")
    except ValueError as e:
        return ToolResult(str(e), ok=False)
    max_chars = max(200, min(int(args.get("max_chars") or 5000), 20000))
    try:
        final_url, ctype, raw, charset = await _fetch(url)
    except httpx.HTTPStatusError as e:
        return ToolResult(f"读取失败：HTTP {e.response.status_code}（{url}）", ok=False)
    except (httpx.ConnectTimeout, httpx.ConnectError) as e:
        return ToolResult(
            f"读取「{url}」连接失败（{type(e).__name__}）：该站点在国内可能无法访问，"
            f"请改读国内可访问的来源（如官网中文站、知乎、CSDN、博客园、IT之家等）。", ok=False)
    except httpx.TimeoutException as e:
        return ToolResult(f"读取「{url}」超时（{type(e).__name__}），网页响应过慢。", ok=False)
    except Exception as e:
        return ToolResult(f"读取「{url}」失败：{type(e).__name__} {e}", ok=False)

    kind = ctype.split(";")[0].strip().lower()
    if kind and not kind.startswith(("text/", "application/xhtml", "application/xml")):
        if "json" in kind:
            try:
                text = json.dumps(json.loads(_decode(raw, charset)), ensure_ascii=False, indent=2)
            except Exception:
                text = _decode(raw, charset)
            return ToolResult(f"{final_url} 返回 JSON 数据：\n{text[:max_chars]}")
        return ToolResult(f"该链接不是网页内容（{kind}），无法读取正文。需要的话可用 open_website 在浏览器打开。",
                          ok=False)

    page = _decode(raw, charset)
    title = _page_title(page)
    body = _html_to_text(page)
    if not body:
        return ToolResult(f"「{final_url}」没有可读正文（可能是纯前端渲染页面）。", ok=False)
    truncated = len(body) > max_chars
    if truncated:
        body = body[:max_chars]
    head = f"《{title}》\n来源：{final_url}\n\n" if title else f"来源：{final_url}\n\n"
    tail = f"\n\n（正文共 {len(body)} 字，已截断）" if truncated else ""
    return ToolResult(head + body + tail)


@tool("open_website", "打开网站",
      "在默认浏览器中打开指定网址。",
      {"url": {"type": "string", "description": "网址", "required": True}})
async def open_website(args: Dict[str, Any], ctx) -> ToolResult:
    try:
        url = _normalize_url(args.get("url") or "")
    except ValueError as e:
        return ToolResult(str(e), ok=False)
    title = url
    try:
        _, _, raw, charset = await _fetch(url)
        title = _page_title(_decode(raw, charset)) or url
    except Exception:
        pass
    try:
        await asyncio.to_thread(os.startfile, url)
    except OSError as e:
        return ToolResult(f"打开网站失败：{e}", ok=False)
    return ToolResult(f"已打开网站 {url}（{title}）。")
