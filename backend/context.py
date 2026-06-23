from __future__ import annotations

import re
from typing import Any

from .storage import store, IS_TESTING


WORD_PATTERN = re.compile(r"[a-zA-Z0-9_À-ÿ]{3,}")
CROSS_WORKSPACE_TERMS = (
    "workspace",
    "ruang kerja",
    "baca",
    "lihat",
    "cek",
    "akses",
    "bandingkan",
    "ambil dari",
    "cari di",
)


def _words(value: str) -> set[str]:
    return {word.casefold() for word in WORD_PATTERN.findall(value)}


def _score(query: set[str], value: str) -> int:
    words = _words(value)
    return len(query & words) * 4 + sum(1 for word in query if word in value.casefold())


def _truncate(value: str, limit: int) -> str:
    value = value.strip()
    return value if len(value) <= limit else value[: limit - 1].rstrip() + "…"


def _content(item: Any) -> str:
    return str(item.get("content", "")) if isinstance(item, dict) else str(item)


def requested_workspaces(active_workspace: str, message: str) -> list[str]:
    lowered = message.casefold()
    if not any(term in lowered for term in CROSS_WORKSPACE_TERMS):
        return []
    requested = []
    for workspace in store.list_workspaces():
        if workspace["id"] == active_workspace:
            continue
        names = {workspace["id"].casefold(), workspace["name"].casefold()}
        if any(name and name in lowered for name in names):
            requested.append(workspace["id"])
    return requested


def _workspace_context(workspace_id: str, message: str, detailed: bool) -> str:
    root = store.workspace_path(workspace_id)
    query = _words(message)
    workspace = next(item for item in store.list_workspaces() if item["id"] == workspace_id)
    mode = "aktif" if detailed else "read-only, jangan adopsi profil gayanya"
    sections = [f"WORKSPACE {workspace['name']} (id: {workspace_id}, {mode})"]

    brain = root / "brain"
    style = store.read_json(brain / "style_profile.json").get("rules", [])
    thinking = store.read_json(brain / "thinking_profile.json").get("patterns", [])
    rules = store.read_json(brain / "rules.json").get("items", [])
    memory = store.read_json(brain / "memory.json").get("items", [])
    concepts = store.read_json(brain / "conversation_memory.json").get("items", [])
    summary = store.read_json(root / "summary" / "workspace_summary.json").get("content", "")

    if summary:
        sections.append("Ringkasan workspace:\n" + _truncate(summary, 1800))
    if style and detailed:
        sections.append("Style profile:\n" + "\n".join(f"- {item}" for item in style[-12:]))
    if thinking and detailed:
        sections.append("Thinking profile:\n" + "\n".join(f"- {item}" for item in thinking[-10:]))
    if rules and detailed:
        sections.append(
            "Aturan pengguna:\n"
            + "\n".join(f"- {_content(item)}" for item in rules[-12:])
        )
    if memory and detailed:
        sections.append(
            "Memori disetujui:\n"
            + "\n".join(f"- {_content(item)}" for item in memory[-12:])
        )
    if concepts:
        sections.append(
            "Konsep lintas chat:\n"
            + "\n".join(f"- {_content(item)}" for item in concepts[-16:])
        )

    drafts = store.list_entities(workspace_id, "drafts")
    references = store.list_entities(workspace_id, "references")
    chats = [chat for chat in store.list_entities(workspace_id, "chats") if not chat.get("archived")]
    sections.append(
        f"Inventaris: {len(drafts)} draft, {len(chats)} chat aktif, {len(references)} referensi."
    )

    ranked_drafts = sorted(
        drafts,
        key=lambda item: _score(query, f"{item.get('title', '')} {item.get('content', '')}"),
        reverse=True,
    )
    selected_drafts = ranked_drafts[: (5 if detailed else 3)]
    if selected_drafts:
        sections.append(
            "Draft relevan:\n"
            + "\n".join(
                f"- {item.get('title', 'Untitled')} [{item['id']}]: "
                f"{_truncate(item.get('content', ''), 900 if detailed else 500)}"
                for item in selected_drafts
            )
        )

    ranked_refs = sorted(
        references,
        key=lambda item: _score(query, f"{item.get('title', '')} {item.get('summary', '')}"),
        reverse=True,
    )
    if ranked_refs[:3]:
        sections.append(
            "Referensi relevan:\n"
            + "\n".join(
                f"- {item.get('title', 'Reference')}: {_truncate(item.get('summary', ''), 500)} "
                f"({item.get('url', '')})"
                for item in ranked_refs[:3]
            )
        )

    chat_summaries = [
        chat for chat in chats if chat.get("summary") and chat.get("id")
    ][:6]
    if chat_summaries:
        sections.append(
            "Ringkasan chat sebelumnya:\n"
            + "\n".join(
                f"- {chat.get('title', chat['id'])}: {_truncate(chat['summary'], 650)}"
                for chat in chat_summaries
            )
        )
    return "\n\n".join(sections)


def build_chat_context(active_workspace: str, message: str) -> tuple[str, list[str]]:
    extras = requested_workspaces(active_workspace, message)
    sections = [_workspace_context(active_workspace, message, detailed=True)]
    sections.extend(_workspace_context(item, message, detailed=False) for item in extras)
    access_note = (
        "Workspace lain hanya boleh digunakan karena pengguna menyebutnya secara eksplisit dalam pesan ini."
        if extras
        else "Jangan membaca atau menyimpulkan data workspace lain."
    )
    models = store.read_json(store.root / "system" / "models.json")
    workspace_names = ", ".join(
        f"{item['name']} ({item['id']})" for item in store.list_workspaces()
    )
    app_name = "GHOSTWRITER" if IS_TESTING else "GHOSTWAITER"
    app_map = (
        f"PETA APLIKASI {app_name}\n"
        "Kemampuan: chat, draft/editor, Brain learning, references, workspace, konfigurasi provider/model, "
        "GitHub sync, snapshot, dan export.\n"
        f"Workspace tersedia: {workspace_names}.\n"
        f"Provider/model saat ini: {models.get('provider', '') or 'belum ditentukan'} / {models.get('model', '') or 'belum ditentukan'}.\n"
        "Data JSON workspace: drafts/*.json, chats/*.json, brain/style_profile.json, "
        "brain/thinking_profile.json, brain/memory.json, brain/rules.json, "
        "brain/conversation_memory.json, brain/learning_proposals.json, references/*.json, "
        "summary/workspace_summary.json. Gunakan konteks yang diberikan untuk menjawab tentang data aplikasi; "
        "jangan mengaku telah membaca file yang tidak ada dalam konteks."
    )
    return f"{app_map}\n\n{access_note}\n\n" + "\n\n---\n\n".join(sections), extras
