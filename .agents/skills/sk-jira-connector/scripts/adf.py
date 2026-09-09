#!/usr/bin/env python3
"""Atlassian Document Format (ADF) <-> Markdown helpers.

Jira Cloud returns rich text fields (description, comment bodies) as ADF — a nested
JSON tree, not HTML or Markdown. To show a human-readable issue we render that tree to
Markdown; to *write* a comment or description we wrap plain Markdown-ish text back into
a minimal ADF document.

The renderer is deliberately lossy-but-faithful: it preserves the things a reader cares
about (headings, lists, tables, code, links, panels) and degrades gracefully on node
types it does not recognise (emitting their text content rather than crashing), because
ADF evolves and an unknown node should never break an issue dump.
"""


def adf_to_markdown(node):
    """Render an ADF document (or any ADF node) to a Markdown string.

    Accepts the raw value of a Jira rich-text field. Returns "" for None/empty so
    callers can treat "no description" uniformly.
    """
    if not node:
        return ""
    if isinstance(node, str):
        return node
    return _render_node(node).strip("\n")


def _render_children(node, sep=""):
    return sep.join(_render_node(c) for c in node.get("content", []) or [])


def _apply_marks(text, marks):
    """Wrap text in Markdown emphasis/link/code per its ADF marks."""
    for mark in marks or []:
        mtype = mark.get("type")
        if mtype == "strong":
            text = f"**{text}**"
        elif mtype == "em":
            text = f"*{text}*"
        elif mtype == "code":
            text = f"`{text}`"
        elif mtype == "strike":
            text = f"~~{text}~~"
        elif mtype == "link":
            href = (mark.get("attrs") or {}).get("href", "")
            text = f"[{text}]({href})" if href else text
    return text


def _render_node(node):
    if not isinstance(node, dict):
        return ""
    ntype = node.get("type")

    if ntype == "doc":
        return _render_children(node, "\n\n")
    if ntype == "text":
        return _apply_marks(node.get("text", ""), node.get("marks"))
    if ntype == "paragraph":
        return _render_children(node)
    if ntype == "hardBreak":
        return "\n"
    if ntype == "heading":
        level = (node.get("attrs") or {}).get("level", 1)
        return f"{'#' * level} {_render_children(node)}"
    if ntype == "bulletList":
        return "\n".join(
            f"- {_render_node(li).strip()}" for li in node.get("content", []) or []
        )
    if ntype == "orderedList":
        items = node.get("content", []) or []
        return "\n".join(
            f"{i + 1}. {_render_node(li).strip()}" for i, li in enumerate(items)
        )
    if ntype == "listItem":
        return _render_children(node, "\n")
    if ntype == "taskList":
        # Interactive Jira checkboxes. Render as GitHub-flavoured task-list lines so
        # the box state (done/open) survives into the Markdown a reader sees — an
        # unrecognised node would otherwise flatten every item onto one line and
        # silently drop whether each is ticked.
        return "\n".join(
            line for ti in node.get("content", []) or []
            if (line := _render_node(ti))
        )
    if ntype == "taskItem":
        state = (node.get("attrs") or {}).get("state", "")
        box = "[x]" if str(state).upper() == "DONE" else "[ ]"
        return f"- {box} {_render_children(node).strip()}"
    if ntype == "codeBlock":
        lang = (node.get("attrs") or {}).get("language", "")
        return f"```{lang}\n{_render_children(node)}\n```"
    if ntype == "blockquote":
        inner = _render_children(node, "\n\n")
        return "\n".join(f"> {line}" for line in inner.splitlines())
    if ntype == "rule":
        return "---"
    if ntype == "panel":
        ptype = (node.get("attrs") or {}).get("panelType", "info")
        return f"> **[{ptype}]** {_render_children(node, ' ')}"
    if ntype in ("mention",):
        attrs = node.get("attrs") or {}
        return f"@{attrs.get('text', attrs.get('id', ''))}"
    if ntype == "emoji":
        attrs = node.get("attrs") or {}
        return attrs.get("text") or attrs.get("shortName", "")
    if ntype == "inlineCard":
        attrs = node.get("attrs") or {}
        return attrs.get("url", "")
    if ntype in ("table",):
        return _render_table(node)
    if ntype in ("tableRow", "tableCell", "tableHeader"):
        # Cells are handled inside _render_table; standalone fall back to children.
        return _render_children(node, " ")
    if ntype == "mediaSingle" or ntype == "mediaGroup":
        return _render_children(node, "\n")
    if ntype == "media":
        attrs = node.get("attrs") or {}
        return f"[media: {attrs.get('id', 'attachment')}]"
    # Unknown node — degrade to its text content rather than crashing.
    return _render_children(node, " ")


def _render_table(node):
    rows = node.get("content", []) or []
    lines = []
    header_emitted = False
    for ri, row in enumerate(rows):
        cells = row.get("content", []) or []
        texts = [_render_children(c, " ").strip().replace("\n", " ") for c in cells]
        lines.append("| " + " | ".join(texts) + " |")
        is_header_row = any(c.get("type") == "tableHeader" for c in cells)
        if (is_header_row or ri == 0) and not header_emitted:
            lines.append("| " + " | ".join("---" for _ in texts) + " |")
            header_emitted = True
    return "\n".join(lines)


def text_to_adf(text):
    """Wrap plain text into a minimal ADF document for writing.

    Blank-line-separated blocks become paragraphs; lines within a block are joined with
    hardBreaks. This is intentionally simple — for comments and short descriptions the
    server accepts it cleanly, and we avoid shipping a full Markdown parser whose edge
    cases would be a maintenance liability. Callers needing rich structure can pass an
    already-built ADF dict to the client instead.
    """
    text = (text or "").strip()
    if not text:
        text = " "
    blocks = text.split("\n\n")
    content = []
    for block in blocks:
        lines = block.split("\n")
        inline = []
        for i, line in enumerate(lines):
            if i > 0:
                inline.append({"type": "hardBreak"})
            if line:
                inline.append({"type": "text", "text": line})
        if not inline:
            inline = [{"type": "text", "text": " "}]
        content.append({"type": "paragraph", "content": inline})
    return {"type": "doc", "version": 1, "content": content}
