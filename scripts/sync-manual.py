#!/usr/bin/env python3
"""
docs/manual.md を大元に、index.html の折りたたみマニュアルと README.md を生成する。
編集後: py -3 scripts/sync-manual.py
"""
from __future__ import annotations

import html
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MANUAL_MD = ROOT / "docs" / "manual.md"
INDEX_HTML = ROOT / "index.html"
README_MD = ROOT / "README.md"

MANUAL_BODY_MARKER = "<!-- manual-body-start -->"

FOLD_SUMMARY_IDS: dict[str, str] = {
    "特記事項": "app-manual-notice-heading",
    "使い方": "app-manual-heading",
    "改変・再利用": "app-manual-source-heading",
    "ライセンス": "app-manual-license-heading",
    "バージョン情報": "app-manual-version-heading",
}

USAGE_SUBSECTION_IDS: dict[str, str] = {
    "ブラウザとプライバシー": "app-manual-cat-browser",
    "ファイルの読み込み": "app-manual-cat-files",
    "再生・ミキシング・表示": "app-manual-cat-playback",
    "キーボードショートカット": "app-manual-cat-keys",
    "データの保存とパフォーマンス": "app-manual-cat-storage",
}

HTML_BEGIN = "    <!-- BEGIN:generated-manual (docs/manual.md → scripts/sync-manual.py) -->"
HTML_END = "    <!-- END:generated-manual -->"


def read_manual() -> str:
    if not MANUAL_MD.is_file():
        print(f"error: missing {MANUAL_MD}", file=sys.stderr)
        sys.exit(1)
    return MANUAL_MD.read_text(encoding="utf-8")


def split_readme_and_body(text: str) -> tuple[str, str]:
    if MANUAL_BODY_MARKER not in text:
        print(f"error: {MANUAL_MD} must contain {MANUAL_BODY_MARKER}", file=sys.stderr)
        sys.exit(1)
    head, body = text.split(MANUAL_BODY_MARKER, 1)
    return head.strip() + "\n", body.strip() + "\n"


def split_h2_sections(body: str) -> list[tuple[str, str]]:
    parts = re.split(r"(?m)^## ", body)
    sections: list[tuple[str, str]] = []
    for part in parts:
        part = part.strip()
        if not part:
            continue
        title, _, content = part.partition("\n")
        sections.append((title.strip(), content.strip()))
    return sections


def inline_md_to_html(text: str) -> str:
    def repl_link(m: re.Match[str]) -> str:
        label = m.group(1)
        url = m.group(2)
        return f'<a href="{html.escape(url, quote=True)}">{html.escape(label)}</a>'

    def repl_code(m: re.Match[str]) -> str:
        return f"<code>{html.escape(m.group(1))}</code>"

    def repl_strong(m: re.Match[str]) -> str:
        return f"<strong>{m.group(1)}</strong>"

    text = re.sub(r"\[([^\]]+)\]\(([^)]+)\)", repl_link, text)
    text = re.sub(r"\*\*(.+?)\*\*", repl_strong, text)
    return re.sub(r"`([^`]+)`", repl_code, text)


def _collect_list(lines: list[str], start: int) -> tuple[str, int]:
    items: list[str] = []
    i = start
    while i < len(lines):
        s = lines[i].strip()
        if s.startswith("- "):
            items.append(inline_md_to_html(s[2:].strip()))
            i += 1
        elif not s:
            i += 1
            break
        else:
            break
    ul = ["        <ul>"]
    for item in items:
        ul.append(f"            <li>{item}</li>")
    ul.append("        </ul>")
    return "\n".join(ul), i


def block_md_to_html(content: str, *, usage_subsections: bool) -> str:
    lines = content.splitlines()
    out: list[str] = []
    i = 0
    while i < len(lines):
        stripped = lines[i].strip()

        if not stripped:
            i += 1
            continue

        if stripped.startswith("<") and (stripped.endswith(">") or "</" in stripped):
            out.append(f"        {stripped}")
            i += 1
            continue

        h3 = re.match(r"^### (.+)$", stripped)
        if h3:
            title = h3.group(1).strip()
            if usage_subsections:
                sid = USAGE_SUBSECTION_IDS.get(title)
                if not sid:
                    print(f"warning: unknown usage subsection {title!r}", file=sys.stderr)
                    sid = re.sub(r"\s+", "-", title)
                out.append(
                    f'        <section class="app-manual-category" aria-labelledby="{sid}">'
                )
                out.append(f'            <h4 id="{sid}">{html.escape(title)}</h4>')
            else:
                out.append(f"        <h3>{html.escape(title)}</h3>")
            i += 1
            while i < len(lines) and not lines[i].strip():
                i += 1
            block, i = _collect_list(lines, i)
            if block.strip():
                out.append(block)
            if usage_subsections:
                out.append("        </section>")
            continue

        if stripped.startswith("- "):
            block, i = _collect_list(lines, i)
            out.append(block)
            continue

        para_lines = [stripped]
        i += 1
        while i < len(lines) and lines[i].strip() and not lines[i].strip().startswith(
            ("- ", "### ", "<")
        ):
            para_lines.append(lines[i].strip())
            i += 1
        out.append(f"        <p>{inline_md_to_html(' '.join(para_lines))}</p>")

    return "\n".join(out)


def build_fold_html(body: str) -> str:
    folds: list[str] = []
    for title, content in split_h2_sections(body):
        if title not in FOLD_SUMMARY_IDS:
            print(f"error: unknown fold section {title!r}", file=sys.stderr)
            sys.exit(1)
        summary_id = FOLD_SUMMARY_IDS[title]
        inner = block_md_to_html(content, usage_subsections=(title == "使い方"))
        folds.append(
            "\n".join(
                [
                    '    <details class="app-doc-fold">',
                    f'        <summary class="app-doc-fold__summary" id="{summary_id}">{html.escape(title)}</summary>',
                    '        <div class="app-doc-fold__body app-manual">',
                    inner,
                    "        </div>",
                    "    </details>",
                ]
            )
        )
    return "\n\n".join(folds)


def patch_index(html_folds: str) -> None:
    text = INDEX_HTML.read_text(encoding="utf-8")
    pattern = re.compile(
        r"[ \t]*<!-- BEGIN:generated-manual.*?-->.*?<!-- END:generated-manual -->",
        re.DOTALL,
    )
    replacement = "\n".join([HTML_BEGIN, html_folds, HTML_END])
    if not pattern.search(text):
        print("error: index.html missing generated-manual markers", file=sys.stderr)
        sys.exit(1)
    INDEX_HTML.write_text(pattern.sub(replacement, text, count=1), encoding="utf-8", newline="\n")


def github_anchor(title: str) -> str:
    """GitHub 目次リンク用のアンカー（日本語見出し向けの簡易版）。"""
    t = title.strip().lower()
    t = t.replace("（", "").replace("）", "").replace("(", "").replace(")", "")
    t = re.sub(r"\s+", "-", t)
    t = re.sub(r"[^0-9a-z\u3040-\u30ff\u3400-\u9fff\-·]", "", t)
    return t


def build_toc(manual_body: str) -> str:
    lines: list[str] = []
    for title, content in split_h2_sections(manual_body):
        lines.append(f"- [{title}](#{github_anchor(title)})")
        if title == "使い方":
            for m in re.finditer(r"^### (.+)$", content, re.MULTILINE):
                sub = m.group(1).strip()
                if re.match(r"^v\d", sub, re.IGNORECASE):
                    continue
                lines.append(f"  - [{sub}](#{github_anchor(sub)})")
    return "\n".join(lines)


def strip_maintainer_comments(text: str) -> str:
    return re.sub(r"<!-- maintainer-only:.*?-->\s*", "", text, flags=re.DOTALL).rstrip() + "\n"


def build_readme(readme_head: str, manual_body: str) -> str:
    body = strip_maintainer_comments(manual_body)
    toc = build_toc(body)
    return (
        readme_head.rstrip()
        + "\n\n## 目次\n\n"
        + toc
        + "\n\n---\n\n"
        + body.lstrip()
        + "\n"
    )


def main() -> None:
    text = read_manual()
    readme_head, manual_body = split_readme_and_body(text)
    body = strip_maintainer_comments(manual_body)
    patch_index(build_fold_html(body))
    README_MD.write_text(build_readme(readme_head, manual_body), encoding="utf-8", newline="\n")
    print(f"updated {INDEX_HTML.relative_to(ROOT)}")
    print(f"updated {README_MD.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
