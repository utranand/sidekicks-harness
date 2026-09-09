"""ADF <-> Markdown rendering."""
from adf import adf_to_markdown, text_to_adf


def _doc(*content):
    return {"type": "doc", "version": 1, "content": list(content)}


def _para(*content):
    return {"type": "paragraph", "content": list(content)}


def _text(t, marks=None):
    n = {"type": "text", "text": t}
    if marks:
        n["marks"] = marks
    return n


def test_empty_is_empty_string():
    assert adf_to_markdown(None) == ""
    assert adf_to_markdown({}) == ""


def test_plain_paragraph():
    assert adf_to_markdown(_doc(_para(_text("hello world")))) == "hello world"


def test_marks_render_as_markdown():
    node = _doc(_para(
        _text("bold", [{"type": "strong"}]),
        _text(" and "),
        _text("code", [{"type": "code"}]),
    ))
    assert adf_to_markdown(node) == "**bold** and `code`"


def test_link_mark():
    node = _doc(_para(_text("site", [{"type": "link", "attrs": {"href": "https://x.io"}}])))
    assert adf_to_markdown(node) == "[site](https://x.io)"


def test_heading_and_bullet_list():
    node = _doc(
        {"type": "heading", "attrs": {"level": 2}, "content": [_text("Title")]},
        {"type": "bulletList", "content": [
            {"type": "listItem", "content": [_para(_text("one"))]},
            {"type": "listItem", "content": [_para(_text("two"))]},
        ]},
    )
    md = adf_to_markdown(node)
    assert "## Title" in md
    assert "- one" in md
    assert "- two" in md


def test_code_block_preserves_language():
    node = _doc({"type": "codeBlock", "attrs": {"language": "sql"},
                 "content": [_text("SELECT 1")]})
    md = adf_to_markdown(node)
    assert md.startswith("```sql")
    assert "SELECT 1" in md


def test_table_renders_with_header_separator():
    cell = lambda t: {"type": "tableCell", "content": [_para(_text(t))]}
    header = lambda t: {"type": "tableHeader", "content": [_para(_text(t))]}
    node = _doc({"type": "table", "content": [
        {"type": "tableRow", "content": [header("A"), header("B")]},
        {"type": "tableRow", "content": [cell("1"), cell("2")]},
    ]})
    md = adf_to_markdown(node)
    assert "| A | B |" in md
    assert "| --- | --- |" in md
    assert "| 1 | 2 |" in md


def test_task_list_renders_checkbox_state():
    node = _doc({"type": "taskList", "attrs": {"localId": "tl"}, "content": [
        {"type": "taskItem", "attrs": {"localId": "t0", "state": "DONE"},
         "content": [_text("done thing")]},
        {"type": "taskItem", "attrs": {"localId": "t1", "state": "TODO"},
         "content": [_text("open thing")]},
    ]})
    md = adf_to_markdown(node)
    assert "- [x] done thing" in md
    assert "- [ ] open thing" in md
    # each item on its own line, not flattened together
    assert md.count("\n") == 1


def test_task_item_unknown_state_is_unchecked():
    node = _doc({"type": "taskList", "attrs": {"localId": "tl"}, "content": [
        {"type": "taskItem", "attrs": {"localId": "t0"},
         "content": [_text("no state")]},
    ]})
    assert adf_to_markdown(node) == "- [ ] no state"


def test_unknown_node_degrades_to_text():
    node = _doc({"type": "someFutureNode", "content": [_para(_text("still readable"))]})
    assert "still readable" in adf_to_markdown(node)


def test_text_to_adf_roundtrips_through_paragraphs():
    doc = text_to_adf("first block\n\nsecond block")
    assert doc["type"] == "doc"
    assert len(doc["content"]) == 2
    # rendering it back should recover the text
    assert "first block" in adf_to_markdown(doc)
    assert "second block" in adf_to_markdown(doc)


def test_text_to_adf_blank_is_safe():
    doc = text_to_adf("")
    assert doc["content"]  # never empty (server rejects empty docs)
