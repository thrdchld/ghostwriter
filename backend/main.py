from __future__ import annotations

import base64
import asyncio
import hashlib
import hmac
import io
import json
import secrets
import time
import zipfile
from contextlib import asynccontextmanager
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Literal

import httpx
from fastapi import FastAPI, HTTPException, BackgroundTasks, Depends, Request, Header, Query, Response, UploadFile, File, Cookie
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from .ai import AIUnavailable, ai_service
from .config import ROOT_DIR, settings
from .context import build_chat_context
from .storage import new_id, now_iso, safe_id, store


FRONTEND_DIR = ROOT_DIR / "frontend"


@asynccontextmanager
async def lifespan(_app: FastAPI):
    async def autosync_loop() -> None:
        while True:
            await asyncio.sleep(settings.sync_debounce_seconds)
            queue = store.read_json(store.root / "queue" / "pending_sync.json")
            if queue.get("items") and settings.github_token and settings.github_repo:
                try:
                    await _github_sync()
                except Exception:
                    pass

    task = asyncio.create_task(autosync_loop())
    yield
    task.cancel()


app = FastAPI(title="GhostWriter", version="1.0.0", docs_url="/api/docs", lifespan=lifespan)


class LoginRequest(BaseModel):
    password: str


class WorkspaceRequest(BaseModel):
    workspace_id: str


class WorkspaceCreateRequest(BaseModel):
    name: str = Field(min_length=1)


class ChatRequest(BaseModel):
    workspace_id: str
    message: str = Field(min_length=1)
    chat_id: str | None = None


class ChatIdRequest(BaseModel):
    workspace_id: str
    chat_id: str


class ChatRenameRequest(ChatIdRequest):
    title: str = Field(min_length=1)


class LearningProposalRequest(BaseModel):
    workspace_id: str
    proposal_id: str
    content: str | None = Field(default=None, min_length=1)


class DraftCreateRequest(BaseModel):
    workspace_id: str
    title: str = Field(default="Untitled")


class DraftUpdateRequest(BaseModel):
    workspace_id: str
    draft_id: str
    title: str | None = Field(default=None)
    content: str | None = Field(default=None)
    collections: list[str] | None = None
    tags: list[str] | None = None


class DraftIdRequest(BaseModel):
    workspace_id: str
    draft_id: str


class GenerateRequest(BaseModel):
    workspace_id: str
    prompt: str = Field(min_length=1)
    mode: Literal["chat", "write", "rewrite", "paraphrase"] = "write"


class RevisionRequest(BaseModel):
    workspace_id: str
    ai_output: str = Field(min_length=1)
    user_revision: str = Field(min_length=1)


class CommitRevisionRequest(BaseModel):
    workspace_id: str
    analysis: dict[str, list[str]]


class RawWritingRequest(BaseModel):
    workspace_id: str
    content: str = Field(min_length=1)
    type: Literal["user", "chat", "import"] = "user"


class ReferenceSearchRequest(BaseModel):
    workspace_id: str
    query: str = Field(min_length=2)
    auto_save: bool = True


class ModelRequest(BaseModel):
    model_id: str = Field(min_length=2)


class ModelChainRequest(BaseModel):
    models: list[str] = Field(min_length=1)


class SnapshotRestoreRequest(BaseModel):
    snapshot_id: str


def error(message: str, status_code: int = 400) -> HTTPException:
    return HTTPException(status_code=status_code, detail={"status": "error", "message": message})


def _sign(value: str) -> str:
    return hmac.new(settings.session_secret.encode(), value.encode(), hashlib.sha256).hexdigest()


def _session_token() -> str:
    timestamp = str(int(time.time()))
    nonce = secrets.token_urlsafe(16)
    value = f"{timestamp}.{nonce}"
    return f"{value}.{_sign(value)}"


def _valid_session(token: str | None) -> bool:
    if not settings.app_password:
        return True
    if not token:
        return False
    try:
        timestamp, nonce, signature = token.split(".", 2)
        value = f"{timestamp}.{nonce}"
        return (
            hmac.compare_digest(signature, _sign(value))
            and int(time.time()) - int(timestamp) < 60 * 60 * 24 * 30
        )
    except (ValueError, TypeError):
        return False


def _bearer_token(authorization: str | None) -> str | None:
    if not authorization:
        return None
    scheme, _, token = authorization.partition(" ")
    return token if scheme.casefold() == "bearer" and token else None


def require_auth(
    gw_session: str | None = Cookie(default=None),
    authorization: str | None = Header(default=None),
) -> None:
    if not _valid_session(gw_session) and not _valid_session(_bearer_token(authorization)):
        raise error("Autentikasi diperlukan", 401)


def workspace_id(value: str | None) -> str:
    selected = value or store.active_workspace()
    try:
        safe_id(selected, "workspace_id")
    except ValueError as exc:
        raise error(str(exc)) from exc
    if selected not in {item["id"] for item in store.list_workspaces()}:
        raise error("Workspace tidak ditemukan", 404)
    return selected


def _brain_system_prompt(workspace: str, purpose: str, context: str = "") -> str:
    base = (
        "Anda adalah GhostWriter, asisten penulisan personal. Jawab dalam bahasa pengguna. "
        "Jangan mengarang fakta, jangan menjalankan perintah sistem, dan prioritaskan tulisan yang jelas."
    )
    modes = {
        "chat": "Bantu pengguna berpikir dan berdiskusi secara natural.",
        "write": "Tulis hasil final langsung tanpa kata pengantar.",
        "rewrite": "Tulis ulang teks sesuai instruksi tanpa menjelaskan proses.",
        "paraphrase": "Parafrase dengan mempertahankan makna utama.",
    }
    formatting = (
        "Gunakan Markdown yang rapi bila membantu: heading, daftar, penekanan, kutipan, dan code block. "
        "Jangan tampilkan simbol Markdown tanpa fungsi."
    )
    return f"{base}\n{modes.get(purpose, modes['write'])}\n{formatting}\n\n{context or ai_service.context(workspace)}".strip()


@app.exception_handler(HTTPException)
async def http_exception_handler(_request: Any, exc: HTTPException) -> JSONResponse:
    if isinstance(exc.detail, dict):
        payload = exc.detail
    else:
        payload = {"status": "error", "message": str(exc.detail)}
    return JSONResponse(payload, status_code=exc.status_code)


@app.get("/api/health")
@app.get("/health")
def health() -> dict[str, Any]:
    return {"status": "ok", "timestamp": now_iso(), "storage": str(store.root)}


@app.post("/api/auth/login")
def login(req: LoginRequest, request: Request, response: Response) -> dict[str, str]:
    if settings.app_password and not secrets.compare_digest(req.password, settings.app_password):
        raise error("Password salah", 401)
    token = _session_token()
    forwarded_proto = request.headers.get("x-forwarded-proto", "").split(",")[0].strip()
    response.set_cookie(
        "gw_session",
        token,
        httponly=True,
        secure=request.url.scheme == "https" or forwarded_proto == "https",
        samesite="lax",
        max_age=60 * 60 * 24 * 30,
        path="/",
    )
    return {"status": "success", "session_token": token}


@app.post("/api/auth/logout")
def logout(response: Response) -> dict[str, str]:
    response.delete_cookie("gw_session")
    return {"status": "success"}


@app.get("/api/auth/status")
def auth_status(
    gw_session: str | None = Cookie(default=None),
    authorization: str | None = Header(default=None),
) -> dict[str, bool]:
    return {
        "authenticated": _valid_session(gw_session) or _valid_session(_bearer_token(authorization)),
        "password_required": bool(settings.app_password),
    }


@app.get("/api/workspace/list", dependencies=[Depends(require_auth)])
def list_workspaces() -> dict[str, Any]:
    return {"items": store.list_workspaces()}


@app.post("/api/workspace/create", dependencies=[Depends(require_auth)])
def create_workspace(req: WorkspaceCreateRequest) -> dict[str, Any]:
    try:
        item = store.create_workspace(req.name)
    except ValueError as exc:
        raise error(str(exc)) from exc
    return {"status": "success", "workspace": item}


@app.post("/api/workspace/switch", dependencies=[Depends(require_auth)])
def switch_workspace(req: WorkspaceRequest) -> dict[str, str]:
    try:
        store.set_active_workspace(req.workspace_id)
    except (ValueError, KeyError) as exc:
        raise error(str(exc), 404) from exc
    return {"status": "success", "workspace_id": req.workspace_id}


@app.get("/api/workspace/current", dependencies=[Depends(require_auth)])
def current_workspace() -> dict[str, Any]:
    active = store.active_workspace()
    return next(item for item in store.list_workspaces() if item["id"] == active)


@app.post("/api/chat/new", dependencies=[Depends(require_auth)])
def new_chat(req: WorkspaceRequest) -> dict[str, str]:
    workspace = workspace_id(req.workspace_id)
    chat_id = new_id("chat")
    timestamp = now_iso()
    store.save_entity(
        workspace,
        "chats",
        {
            "schema_version": 1,
            "id": chat_id,
            "title": "Obrolan baru",
            "messages": [],
            "created_at": timestamp,
            "updated_at": timestamp,
            "archived": False,
            "summary": "",
            "accessed_workspaces": [],
        },
    )
    return {"chat_id": chat_id}


@app.get("/api/chat/list", dependencies=[Depends(require_auth)])
def list_chats(
    workspace_id_query: str | None = Query(default=None, alias="workspace_id"),
    archived: bool | None = Query(default=None),
) -> dict[str, Any]:
    workspace = workspace_id(workspace_id_query)
    items = store.list_entities(workspace, "chats")
    if archived is not None:
        items = [item for item in items if bool(item.get("archived")) is archived]
    return {"items": items}


@app.get("/api/chat/session/{chat_id}", dependencies=[Depends(require_auth)])
def get_chat(chat_id: str, workspace_id_query: str | None = Query(default=None, alias="workspace_id")) -> dict[str, Any]:
    try:
        return store.get_entity(workspace_id(workspace_id_query), "chats", chat_id)
    except (FileNotFoundError, ValueError) as exc:
        raise error("Chat tidak ditemukan", 404) from exc


@app.post("/api/chat/archive", dependencies=[Depends(require_auth)])
def archive_chat(req: ChatIdRequest) -> dict[str, str]:
    try:
        chat = store.get_entity(workspace_id(req.workspace_id), "chats", req.chat_id)
    except (FileNotFoundError, ValueError) as exc:
        raise error("Chat tidak ditemukan", 404) from exc
    chat["archived"] = True
    chat["updated_at"] = now_iso()
    store.save_entity(req.workspace_id, "chats", chat)
    return {"status": "success"}


@app.post("/api/chat/restore", dependencies=[Depends(require_auth)])
def restore_chat(req: ChatIdRequest) -> dict[str, str]:
    try:
        chat = store.get_entity(workspace_id(req.workspace_id), "chats", req.chat_id)
    except (FileNotFoundError, ValueError) as exc:
        raise error("Chat tidak ditemukan", 404) from exc
    chat["archived"] = False
    chat["updated_at"] = now_iso()
    store.save_entity(req.workspace_id, "chats", chat)
    return {"status": "success"}


@app.post("/api/chat/rename", dependencies=[Depends(require_auth)])
def rename_chat(req: ChatRenameRequest) -> dict[str, str]:
    try:
        chat = store.get_entity(workspace_id(req.workspace_id), "chats", req.chat_id)
    except (FileNotFoundError, ValueError) as exc:
        raise error("Chat tidak ditemukan", 404) from exc
    chat["title"] = " ".join(req.title.split())
    chat["updated_at"] = now_iso()
    store.save_entity(req.workspace_id, "chats", chat)
    return {"status": "success", "title": chat["title"]}


@app.post("/api/chat/delete-permanent", dependencies=[Depends(require_auth)])
def permanently_delete_chat(req: ChatIdRequest) -> dict[str, str]:
    try:
        chat = store.get_entity(workspace_id(req.workspace_id), "chats", req.chat_id)
        if not chat.get("archived"):
            raise error("Chat harus diarsipkan sebelum dihapus permanen")
        store.permanently_delete_entity(req.workspace_id, "chats", req.chat_id)
    except HTTPException:
        raise
    except (FileNotFoundError, ValueError) as exc:
        raise error("Chat tidak ditemukan", 404) from exc
    return {"status": "success"}


async def _analyze_chat_background(workspace: str, chat_id: str) -> None:
    try:
        chat = store.get_entity(workspace, "chats", chat_id)
        analysis = await ai_service.analyze_chat(chat.get("messages", []), chat.get("summary", ""))
        chat["summary"] = analysis["summary"]
        chat["updated_at"] = now_iso()
        store.save_entity(workspace, "chats", chat)

        root = store.workspace_path(workspace)
        memory_path = root / "brain" / "conversation_memory.json"
        memory = store.read_json(memory_path)
        known_concepts = {
            (item.get("content", "") if isinstance(item, dict) else str(item)).casefold()
            for item in memory.get("items", [])
        }
        for concept in analysis["concepts"]:
            if concept.casefold() not in known_concepts:
                memory["items"].append(
                    {
                        "id": new_id("concept"),
                        "content": concept,
                        "source_chat_id": chat_id,
                        "created_at": now_iso(),
                    }
                )
        memory["items"] = memory["items"][-200:]
        store.write_json(memory_path, memory)

        proposal_path = root / "brain" / "learning_proposals.json"
        proposals = store.read_json(proposal_path)
        existing = {
            (item.get("type"), item.get("content", "").casefold())
            for item in proposals.get("items", [])
            if isinstance(item, dict) and item.get("status", "pending") != "rejected"
        }
        for item in analysis["proposals"]:
            key = (item["type"], item["content"].casefold())
            if key not in existing:
                proposals["items"].insert(
                    0,
                    {
                        "id": new_id("learn"),
                        "type": item["type"],
                        "content": item["content"],
                        "source_chat_id": chat_id,
                        "status": "pending",
                        "created_at": now_iso(),
                        "updated_at": now_iso(),
                    },
                )
        proposals["items"] = proposals["items"][:200]
        store.write_json(proposal_path, proposals)

        summary_path = root / "summary" / "workspace_summary.json"
        workspace_summary = store.read_json(summary_path)
        summaries = [
            item.get("summary", "")
            for item in store.list_entities(workspace, "chats")[:12]
            if item.get("summary") and not item.get("archived")
        ]
        workspace_summary["content"] = "\n".join(f"- {item}" for item in summaries)
        workspace_summary["updated_at"] = now_iso()
        store.write_json(summary_path, workspace_summary)
        store.enqueue_sync("brain", workspace, {"chat_id": chat_id, "analysis": "updated"})
    except Exception:
        return


async def _chat_stream(workspace: str, chat: dict[str, Any], user_message: str):
    chat["messages"].append({"role": "user", "content": user_message, "timestamp": now_iso()})
    app_context, accessed_workspaces = build_chat_context(workspace, user_message)
    chat["accessed_workspaces"] = accessed_workspaces
    messages = [{"role": "system", "content": _brain_system_prompt(workspace, "chat", app_context)}]
    if chat.get("summary"):
        messages.append(
            {"role": "system", "content": f"Ringkasan percakapan sebelumnya:\n{chat['summary']}"}
        )
    messages.extend(
        {"role": item["role"], "content": item["content"]}
        for item in chat["messages"][-14:]
        if item["role"] in {"user", "assistant"}
    )
    chunks: list[str] = []
    try:
        async for text in ai_service.stream(messages):
            chunks.append(text)
            yield text
    except AIUnavailable as exc:
        yield f"\n\n[Error: {exc}]"
    finally:
        answer = "".join(chunks).strip()
        if answer:
            chat["messages"].append({"role": "assistant", "content": answer, "timestamp": now_iso()})
        chat["updated_at"] = now_iso()
        if chat["title"] == "Obrolan baru":
            chat["title"] = user_message[:60]
        store.save_entity(workspace, "chats", chat)
        if answer:
            asyncio.create_task(_analyze_chat_background(workspace, chat["id"]))


@app.post("/api/chat/send", dependencies=[Depends(require_auth)])
def send_chat(req: ChatRequest) -> StreamingResponse:
    workspace = workspace_id(req.workspace_id)
    if req.chat_id:
        try:
            chat = store.get_entity(workspace, "chats", req.chat_id)
        except (FileNotFoundError, ValueError) as exc:
            raise error("Chat tidak ditemukan", 404) from exc
        if chat.get("archived"):
            raise error("Chat berada di arsip. Restore chat sebelum melanjutkan.", 409)
    else:
        chat_id = new_id("chat")
        timestamp = now_iso()
        chat = {
            "schema_version": 1,
            "id": chat_id,
            "title": "Obrolan baru",
            "messages": [],
            "created_at": timestamp,
            "updated_at": timestamp,
            "archived": False,
            "summary": "",
            "accessed_workspaces": [],
        }
    return StreamingResponse(
        _chat_stream(workspace, chat, req.message),
        media_type="text/plain; charset=utf-8",
        headers={"X-Chat-Id": chat["id"], "Cache-Control": "no-cache"},
    )


@app.post("/api/draft/create", dependencies=[Depends(require_auth)])
def create_draft(req: DraftCreateRequest) -> dict[str, Any]:
    workspace = workspace_id(req.workspace_id)
    timestamp = now_iso()
    draft = {
        "schema_version": 1,
        "id": new_id("draft"),
        "title": req.title.strip() or "Untitled",
        "content": "",
        "collections": [],
        "tags": [],
        "created_at": timestamp,
        "updated_at": timestamp,
        "status": "active",
    }
    return store.save_entity(workspace, "drafts", draft)


@app.post("/api/draft/update", dependencies=[Depends(require_auth)])
def update_draft(req: DraftUpdateRequest) -> dict[str, Any]:
    workspace = workspace_id(req.workspace_id)
    try:
        draft = store.get_entity(workspace, "drafts", req.draft_id)
    except (FileNotFoundError, ValueError) as exc:
        raise error("Draft tidak ditemukan", 404) from exc
    changes = req.model_dump(exclude_none=True, exclude={"workspace_id", "draft_id"})
    draft.update(changes)
    draft["updated_at"] = now_iso()
    return store.save_entity(workspace, "drafts", draft)


@app.get("/api/draft/list", dependencies=[Depends(require_auth)])
def list_drafts(
    workspace_id_query: str | None = Query(default=None, alias="workspace_id"),
    query: str = "",
) -> dict[str, Any]:
    drafts = store.list_entities(workspace_id(workspace_id_query), "drafts")
    if query:
        needle = query.casefold()
        drafts = [item for item in drafts if needle in f"{item.get('title', '')} {item.get('content', '')}".casefold()]
    return {"items": drafts}


@app.get("/api/draft/{draft_id}", dependencies=[Depends(require_auth)])
def get_draft(draft_id: str, workspace_id_query: str | None = Query(default=None, alias="workspace_id")) -> dict[str, Any]:
    try:
        return store.get_entity(workspace_id(workspace_id_query), "drafts", draft_id)
    except (FileNotFoundError, ValueError) as exc:
        raise error("Draft tidak ditemukan", 404) from exc


@app.post("/api/draft/delete", dependencies=[Depends(require_auth)])
def delete_draft(req: DraftIdRequest) -> dict[str, str]:
    try:
        store.delete_entity(workspace_id(req.workspace_id), "drafts", req.draft_id)
    except (FileNotFoundError, ValueError) as exc:
        raise error("Draft tidak ditemukan", 404) from exc
    return {"status": "success"}


async def _generate_stream(workspace: str, prompt: str, mode: str):
    messages = [
        {"role": "system", "content": _brain_system_prompt(workspace, mode)},
        {"role": "user", "content": prompt},
    ]
    try:
        async for text in ai_service.stream(messages):
            yield text
    except AIUnavailable as exc:
        yield f"[Error: {exc}]"


@app.post("/api/ai/generate", dependencies=[Depends(require_auth)])
def generate(req: GenerateRequest) -> StreamingResponse:
    workspace = workspace_id(req.workspace_id)
    return StreamingResponse(
        _generate_stream(workspace, req.prompt, req.mode),
        media_type="text/plain; charset=utf-8",
        headers={"Cache-Control": "no-cache"},
    )


@app.post("/api/brain/learn/revision", dependencies=[Depends(require_auth)])
async def learn_revision(req: RevisionRequest) -> dict[str, Any]:
    workspace = workspace_id(req.workspace_id)
    try:
        analysis = await ai_service.learn_revision(req.ai_output, req.user_revision)
    except AIUnavailable as exc:
        raise error(str(exc), 503) from exc
    timestamp = now_iso()
    store.save_entity(
        workspace,
        "learning/revision_pairs",
        {
            "schema_version": 1,
            "id": new_id("rev"),
            "ai_output": req.ai_output,
            "user_revision": req.user_revision,
            "analysis": analysis,
            "created_at": timestamp,
        },
    )
    brain = store.workspace_path(workspace) / "brain"
    style = store.read_json(brain / "style_profile.json")
    thinking = store.read_json(brain / "thinking_profile.json")
    style["rules"] = list(dict.fromkeys(style.get("rules", []) + analysis["style_rules"]))[-100:]
    thinking["patterns"] = list(dict.fromkeys(thinking.get("patterns", []) + analysis["thinking_patterns"]))[-100:]
    store.write_json(brain / "style_profile.json", style)
    store.write_json(brain / "thinking_profile.json", thinking)
    store.enqueue_sync("brain", workspace, analysis)
    return {"status": "learned", "analysis": analysis}


@app.post("/api/brain/compare-revision", dependencies=[Depends(require_auth)])
async def compare_revision(req: RevisionRequest) -> dict[str, Any]:
    try:
        analysis = await ai_service.learn_revision(req.ai_output, req.user_revision)
    except AIUnavailable as exc:
        raise error(str(exc), 503) from exc
    return {"status": "analyzed", "analysis": analysis}


@app.post("/api/brain/commit-revision", dependencies=[Depends(require_auth)])
async def commit_revision(req: CommitRevisionRequest) -> dict[str, Any]:
    workspace = workspace_id(req.workspace_id)
    analysis = req.analysis
    brain = store.workspace_path(workspace) / "brain"
    style = store.read_json(brain / "style_profile.json")
    thinking = store.read_json(brain / "thinking_profile.json")
    style["rules"] = list(dict.fromkeys(style.get("rules", []) + analysis.get("style_rules", [])))[-100:]
    thinking["patterns"] = list(dict.fromkeys(thinking.get("patterns", []) + analysis.get("thinking_patterns", [])))[-100:]
    store.write_json(brain / "style_profile.json", style)
    store.write_json(brain / "thinking_profile.json", thinking)
    store.enqueue_sync("brain", workspace, analysis)
    return {"status": "learned"}


@app.post("/api/brain/learn/raw-writing", dependencies=[Depends(require_auth)])
async def learn_raw(req: RawWritingRequest) -> dict[str, Any]:
    workspace = workspace_id(req.workspace_id)
    prompt = (
        "Analisis gaya tulisan berikut. Balas satu aturan gaya yang konkret, singkat, "
        "dan dapat diterapkan kembali. Jangan merangkum isi."
    )
    try:
        rule = (
            await ai_service.complete(
                [{"role": "system", "content": prompt}, {"role": "user", "content": req.content}],
                max_tokens=160,
                temperature=0.2,
            )
        ).strip()
    except AIUnavailable as exc:
        raise error(str(exc), 503) from exc
    item = {
        "schema_version": 1,
        "id": new_id("raw"),
        "content": req.content,
        "type": req.type,
        "analysis": rule,
        "created_at": now_iso(),
    }
    store.save_entity(workspace, "learning/raw_writing", item)
    profile_path = store.workspace_path(workspace) / "brain" / "style_profile.json"
    profile = store.read_json(profile_path)
    profile["rules"] = list(dict.fromkeys(profile.get("rules", []) + [rule]))[-100:]
    store.write_json(profile_path, profile)
    return {"status": "learned", "rule": rule}


@app.get("/api/brain/profile", dependencies=[Depends(require_auth)])
def brain_profile(workspace_id_query: str | None = Query(default=None, alias="workspace_id")) -> dict[str, Any]:
    workspace = workspace_id(workspace_id_query)
    brain = store.workspace_path(workspace) / "brain"
    return {
        "style_profile": store.read_json(brain / "style_profile.json"),
        "thinking_profile": store.read_json(brain / "thinking_profile.json"),
        "rules": store.read_json(brain / "rules.json").get("items", []),
        "memory": store.read_json(brain / "memory.json").get("items", []),
        "conversation_memory": store.read_json(brain / "conversation_memory.json").get("items", []),
        "pending_proposals": len(
            [
                item
                for item in store.read_json(brain / "learning_proposals.json").get("items", [])
                if item.get("status", "pending") == "pending"
            ]
        ),
        "revision_count": len(store.list_entities(workspace, "learning/revision_pairs")),
        "raw_writing_count": len(store.list_entities(workspace, "learning/raw_writing")),
    }


@app.post("/api/reference/search", dependencies=[Depends(require_auth)])
async def search_references(req: ReferenceSearchRequest) -> dict[str, Any]:
    workspace = workspace_id(req.workspace_id)
    if not settings.tavily_api_key:
        raise error("TAVILY_API_KEY belum dikonfigurasi untuk pencarian web", 503)
    async with httpx.AsyncClient(timeout=30) as client:
        response = await client.post(
            "https://api.tavily.com/search",
            json={
                "api_key": settings.tavily_api_key,
                "query": req.query,
                "search_depth": "basic",
                "max_results": 5,
            },
        )
        response.raise_for_status()
        results = response.json().get("results", [])
    items = []
    for result in results:
        item = {
            "schema_version": 1,
            "id": new_id("ref"),
            "title": result.get("title", "Reference"),
            "source": "web",
            "url": result.get("url", ""),
            "summary": result.get("content", ""),
            "tags": [req.query],
            "created_at": now_iso(),
        }
        if req.auto_save:
            store.save_entity(workspace, "references", item)
        items.append(item)
    return {"items": items}


@app.get("/api/reference/list", dependencies=[Depends(require_auth)])
def list_references(workspace_id_query: str | None = Query(default=None, alias="workspace_id")) -> dict[str, Any]:
    return {"items": store.list_entities(workspace_id(workspace_id_query), "references")}


@app.get("/api/reference/{reference_id}", dependencies=[Depends(require_auth)])
def get_reference(
    reference_id: str,
    workspace_id_query: str | None = Query(default=None, alias="workspace_id"),
) -> dict[str, Any]:
    try:
        return store.get_entity(workspace_id(workspace_id_query), "references", reference_id)
    except (FileNotFoundError, ValueError) as exc:
        raise error("Referensi tidak ditemukan", 404) from exc


@app.get("/api/model/status", dependencies=[Depends(require_auth)])
def model_status() -> dict[str, Any]:
    models_file = store.read_json(store.root / "system" / "models.json")
    return {
        "active_model": ai_service.active_model,
        "default_model": models_file.get("default_model", settings.default_model),
        "fallback_models": models_file.get("fallback_models", []),
        "fallback_chain": list(ai_service.models),
        "configured": bool(settings.hf_token),
        "provider": settings.inference_provider,
        "last_error": ai_service.last_error,
    }


@app.post("/api/model/set-default", dependencies=[Depends(require_auth)])
def set_default_model(req: ModelRequest) -> dict[str, str]:
    path = store.root / "system" / "models.json"
    data = store.read_json(path)
    previous = data.get("default_model")
    data["default_model"] = req.model_id
    fallbacks = [item for item in data.get("fallback_models", []) if item != req.model_id]
    if previous and previous != req.model_id:
        fallbacks.insert(0, previous)
    data["fallback_models"] = list(dict.fromkeys(fallbacks))[:11]
    store.write_json(path, data)
    ai_service.active_model = req.model_id
    return {"status": "success", "model_id": req.model_id}


@app.post("/api/model/add-fallback", dependencies=[Depends(require_auth)])
def add_fallback_model(req: ModelRequest) -> dict[str, Any]:
    path = store.root / "system" / "models.json"
    data = store.read_json(path)
    if req.model_id != data.get("default_model"):
        data["fallback_models"] = list(
            dict.fromkeys(data.get("fallback_models", []) + [req.model_id])
        )[:11]
    store.write_json(path, data)
    return {"status": "success", "fallback_models": data["fallback_models"]}


@app.post("/api/model/remove", dependencies=[Depends(require_auth)])
def remove_model(req: ModelRequest) -> dict[str, Any]:
    path = store.root / "system" / "models.json"
    data = store.read_json(path)
    if req.model_id == data.get("default_model"):
        raise error("Model default tidak dapat dihapus. Pilih default lain terlebih dahulu.")
    data["fallback_models"] = [
        item for item in data.get("fallback_models", []) if item != req.model_id
    ]
    store.write_json(path, data)
    return {"status": "success", "fallback_models": data["fallback_models"]}


@app.post("/api/model/reorder", dependencies=[Depends(require_auth)])
def reorder_models(req: ModelChainRequest) -> dict[str, Any]:
    unique = list(dict.fromkeys(item.strip() for item in req.models if item.strip()))
    path = store.root / "system" / "models.json"
    data = store.read_json(path)
    data["default_model"] = unique[0]
    data["fallback_models"] = unique[1:]
    store.write_json(path, data)
    return {"status": "success", "models": unique}


@app.post("/api/model/test", dependencies=[Depends(require_auth)])
async def test_model(req: ModelRequest) -> dict[str, Any]:
    try:
        response = await ai_service.client().chat_completion(
            model=req.model_id,
            messages=[{"role": "user", "content": "Balas hanya: OK"}],
            max_tokens=8,
            temperature=0,
        )
        return {
            "status": "success",
            "model_id": req.model_id,
            "response": response.choices[0].message.content or "",
        }
    except Exception as exc:
        raise error(f"Model tidak dapat digunakan: {exc}", 503) from exc


@app.get("/api/model/search", dependencies=[Depends(require_auth)])
async def search_models(query: str = Query(min_length=2, max_length=100)) -> dict[str, Any]:
    async with httpx.AsyncClient(timeout=20) as client:
        response = await client.get(
            "https://huggingface.co/api/models",
            params={"search": query, "pipeline_tag": "text-generation", "sort": "downloads", "direction": -1, "limit": 20},
        )
        response.raise_for_status()
    return {
        "items": [
            {
                "id": item.get("id"),
                "downloads": item.get("downloads", 0),
                "likes": item.get("likes", 0),
                "private": item.get("private", False),
                "gated": item.get("gated", False),
                "pipeline_tag": item.get("pipeline_tag", ""),
                "inference": item.get("inference"),
            }
            for item in response.json()
        ]
    }


def _proposal_file(workspace: str) -> Path:
    return store.workspace_path(workspace) / "brain" / "learning_proposals.json"


@app.get("/api/brain/proposals", dependencies=[Depends(require_auth)])
def list_learning_proposals(
    workspace_id_query: str | None = Query(default=None, alias="workspace_id"),
    status: str = Query(default="pending", pattern="^(pending|approved|rejected|all)$"),
) -> dict[str, Any]:
    workspace = workspace_id(workspace_id_query)
    items = store.read_json(_proposal_file(workspace)).get("items", [])
    if status != "all":
        items = [item for item in items if item.get("status", "pending") == status]
    return {"items": items}


@app.post("/api/brain/proposals/approve", dependencies=[Depends(require_auth)])
def approve_learning_proposal(req: LearningProposalRequest) -> dict[str, Any]:
    workspace = workspace_id(req.workspace_id)
    path = _proposal_file(workspace)
    data = store.read_json(path)
    proposal = next((item for item in data["items"] if item["id"] == req.proposal_id), None)
    if not proposal:
        raise error("Usulan pembelajaran tidak ditemukan", 404)
    content = (req.content or proposal["content"]).strip()
    proposal.update({"content": content, "status": "approved", "updated_at": now_iso()})
    brain = store.workspace_path(workspace) / "brain"
    targets = {
        "style": (brain / "style_profile.json", "rules"),
        "thinking": (brain / "thinking_profile.json", "patterns"),
        "memory": (brain / "memory.json", "items"),
        "rule": (brain / "rules.json", "items"),
    }
    target_path, key = targets[proposal["type"]]
    target = store.read_json(target_path)
    if proposal["type"] in {"memory", "rule"}:
        existing = {
            (item.get("content", "") if isinstance(item, dict) else str(item)).casefold()
            for item in target.get(key, [])
        }
        if content.casefold() not in existing:
            target.setdefault(key, []).append(
                {
                    "id": new_id(proposal["type"]),
                    "content": content,
                    "source_chat_id": proposal.get("source_chat_id"),
                    "created_at": now_iso(),
                }
            )
    else:
        target[key] = list(dict.fromkeys(target.get(key, []) + [content]))[-100:]
    store.write_json(target_path, target)
    store.write_json(path, data)
    store.enqueue_sync("brain", workspace, {"proposal_id": proposal["id"], "status": "approved"})
    return {"status": "success", "proposal": proposal}


@app.post("/api/brain/proposals/reject", dependencies=[Depends(require_auth)])
def reject_learning_proposal(req: LearningProposalRequest) -> dict[str, Any]:
    workspace = workspace_id(req.workspace_id)
    path = _proposal_file(workspace)
    data = store.read_json(path)
    proposal = next((item for item in data["items"] if item["id"] == req.proposal_id), None)
    if not proposal:
        raise error("Usulan pembelajaran tidak ditemukan", 404)
    proposal.update({"status": "rejected", "updated_at": now_iso()})
    store.write_json(path, data)
    return {"status": "success"}


def _backup_payload() -> dict[str, Any]:
    payload: dict[str, Any] = {"schema_version": 1, "created_at": now_iso(), "files": {}}
    for path in store.root.rglob("*.json"):
        if ".git" not in path.parts:
            payload["files"][str(path.relative_to(store.root))] = store.read_json(path)
    return payload


async def _github_sync() -> tuple[bool, str]:
    if not settings.github_token or not settings.github_repo:
        return False, "GITHUB_TOKEN atau GITHUB_BACKUP_REPO belum dikonfigurasi"
    owner_repo = settings.github_repo.removeprefix("https://github.com/").removesuffix(".git").strip("/")
    if owner_repo.count("/") != 1:
        return False, "Format GITHUB_BACKUP_REPO harus owner/repo"
    api_url = f"https://api.github.com/repos/{owner_repo}/contents/ghostwriter-backup.json"
    headers = {
        "Authorization": f"Bearer {settings.github_token}",
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
    }
    content = base64.b64encode(json.dumps(_backup_payload(), ensure_ascii=False).encode()).decode()
    async with httpx.AsyncClient(timeout=60, headers=headers) as client:
        current = await client.get(api_url)
        body: dict[str, Any] = {
            "message": f"GhostWriter sync {datetime.now(UTC).strftime('%Y-%m-%d %H:%M:%S UTC')}",
            "content": content,
        }
        if current.status_code == 200:
            body["sha"] = current.json()["sha"]
        elif current.status_code != 404:
            return False, f"GitHub API: {current.status_code} {current.text[:200]}"
        result = await client.put(api_url, json=body)
        if result.status_code not in {200, 201}:
            return False, f"GitHub API: {result.status_code} {result.text[:200]}"
    queue_path = store.root / "queue" / "pending_sync.json"
    store.write_json(queue_path, {"schema_version": 1, "items": []})
    system_path = store.root / "system" / "settings.json"
    system = store.read_json(system_path)
    system.update({"sync_status": "ok", "last_sync": now_iso()})
    store.write_json(system_path, system)
    return True, ""


@app.post("/api/sync/run", dependencies=[Depends(require_auth)])
async def run_sync() -> dict[str, Any]:
    ok, message = await _github_sync()
    if not ok:
        raise error(message, 503)
    return {"status": "success", "last_sync": now_iso()}


@app.get("/api/sync/status", dependencies=[Depends(require_auth)])
def sync_status() -> dict[str, Any]:
    system = store.read_json(store.root / "system" / "settings.json")
    queue = store.read_json(store.root / "queue" / "pending_sync.json")
    return {
        "status": system.get("sync_status", "idle"),
        "queue_size": len(queue.get("items", [])),
        "last_sync": system.get("last_sync", ""),
        "configured": bool(settings.github_token and settings.github_repo),
    }


@app.get("/api/sync/queue", dependencies=[Depends(require_auth)])
def sync_queue() -> dict[str, Any]:
    return store.read_json(store.root / "queue" / "pending_sync.json")


@app.post("/api/sync/retry", dependencies=[Depends(require_auth)])
async def retry_sync() -> dict[str, Any]:
    return await run_sync()


@app.post("/api/snapshot/create", dependencies=[Depends(require_auth)])
def create_snapshot() -> dict[str, Any]:
    return store.create_snapshot()


@app.get("/api/snapshot/list", dependencies=[Depends(require_auth)])
def list_snapshots() -> dict[str, Any]:
    return store.read_json(store.root / "snapshots" / "manifest.json")


@app.get("/api/snapshot/download/{snapshot_id}", dependencies=[Depends(require_auth)])
def download_snapshot(snapshot_id: str) -> FileResponse:
    try:
        path = store.snapshot_path(snapshot_id)
    except FileNotFoundError as exc:
        raise error("Snapshot tidak ditemukan", 404) from exc
    return FileResponse(path, media_type="application/zip", filename=path.name)


@app.post("/api/snapshot/restore", dependencies=[Depends(require_auth)])
def restore_snapshot(req: SnapshotRestoreRequest) -> dict[str, str]:
    try:
        path = store.snapshot_path(req.snapshot_id)
    except FileNotFoundError as exc:
        raise error("Snapshot tidak ditemukan", 404) from exc
    store.create_snapshot()
    with zipfile.ZipFile(path) as archive:
        root = store.root.resolve()
        for member in archive.infolist():
            target = (root / member.filename).resolve()
            if root not in target.parents and target != root:
                raise error("Snapshot mengandung path yang tidak aman")
        archive.extractall(store.root)
    return {"status": "success"}


@app.get("/api/export", dependencies=[Depends(require_auth)])
def export_data() -> StreamingResponse:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
        for path in store.root.rglob("*.json"):
            archive.write(path, path.relative_to(store.root))
    buffer.seek(0)
    filename = f"ghostwriter_{datetime.now(UTC).strftime('%Y%m%d_%H%M%S')}.zip"
    return StreamingResponse(
        buffer,
        media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@app.post("/api/import", dependencies=[Depends(require_auth)])
def import_data(file: UploadFile = File(...)) -> dict[str, str]:
    if not file.filename.endswith(".zip"):
        raise error("File harus berupa .zip")
        
    import tempfile
    import shutil
    import json
    
    with tempfile.TemporaryDirectory() as tmpdir:
        tmp_path = Path(tmpdir)
        zip_path = tmp_path / "upload.zip"
        with open(zip_path, "wb") as f:
            shutil.copyfileobj(file.file, f)
            
        try:
            with zipfile.ZipFile(zip_path) as archive:
                archive.extractall(tmp_path)
        except zipfile.BadZipFile:
            raise error("File zip rusak atau tidak valid")
            
        workspaces_dir = tmp_path / "workspaces"
        if not workspaces_dir.exists() or not workspaces_dir.is_dir():
            raise error("Tidak ditemukan folder workspaces dalam zip")
            
        existing_names = {ws["name"] for ws in store.list_workspaces()}
        
        for ws_dir in workspaces_dir.iterdir():
            if not ws_dir.is_dir():
                continue
            data_file = ws_dir / "data.json"
            if not data_file.exists():
                continue
                
            try:
                ws_data = json.loads(data_file.read_text("utf-8"))
                original_name = ws_data.get("name", "Imported Workspace")
            except Exception:
                continue
                
            new_name = original_name
            counter = 1
            while new_name in existing_names:
                new_name = f"{original_name} ({counter})"
                counter += 1
                
            existing_names.add(new_name)
            new_ws = store.create_workspace(new_name)
            new_id = new_ws["id"]
            dest_dir = store.workspace_path(new_id)
            
            for item in ws_dir.iterdir():
                if item.is_dir():
                    shutil.copytree(item, dest_dir / item.name, dirs_exist_ok=True)
                elif item.name == "data.json":
                    ws_data["id"] = new_id
                    ws_data["name"] = new_name
                    (dest_dir / "data.json").write_text(json.dumps(ws_data), "utf-8")
                else:
                    shutil.copy2(item, dest_dir / item.name)

    return {"status": "success"}


@app.get("/api/offline/cache/status")
def offline_status() -> dict[str, Any]:
    return {"status": "available", "strategy": "service-worker-shell-and-local-draft"}


app.mount("/assets", StaticFiles(directory=FRONTEND_DIR / "assets"), name="assets")


@app.get("/manifest.webmanifest", include_in_schema=False)
def manifest() -> FileResponse:
    return FileResponse(FRONTEND_DIR / "manifest.webmanifest", media_type="application/manifest+json")


@app.get("/service-worker.js", include_in_schema=False)
def service_worker() -> FileResponse:
    return FileResponse(FRONTEND_DIR / "service-worker.js", media_type="application/javascript")


@app.get("/", include_in_schema=False)
def index() -> FileResponse:
    return FileResponse(FRONTEND_DIR / "index.html")
