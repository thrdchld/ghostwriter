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
    yield


app = FastAPI(title="Ghostwaiter", version="1.0.0", docs_url="/api/docs", lifespan=lifespan)


class LoginRequest(BaseModel):
    password: str


class WorkspaceRequest(BaseModel):
    workspace_id: str


class WorkspaceCreateRequest(BaseModel):
    name: str = Field(min_length=1)


class WorkspaceRenameRequest(WorkspaceRequest):
    name: str = Field(min_length=1)

class WorkspaceDeleteRequest(WorkspaceRequest):
    pass

class BrainItemUpdateRequest(WorkspaceRequest):
    type: Literal["style", "thinking", "memory"]
    id_or_content: str
    new_content: str = Field(min_length=1)

class BrainItemDeleteRequest(WorkspaceRequest):
    type: Literal["style", "thinking", "memory"]
    id_or_content: str

class ProposalBulkRequest(WorkspaceRequest):
    action: Literal["approve", "reject"]
    proposal_ids: list[str]

class ChatAttachment(BaseModel):
    name: str
    size: int
    type: str
    content: str  # Base64 data or text content

class ChatRequest(BaseModel):
    workspace_id: str
    message: str = Field(min_length=1)
    chat_id: str | None = None
    attachments: list[ChatAttachment] | None = None


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


class NoteSaveRequest(BaseModel):
    workspace_id: str
    id: str | None = None
    title: str = ""
    content: str = ""
    pinned: bool = False
    tags: list[str] = []
    image: str | None = None


class NoteIdRequest(BaseModel):
    workspace_id: str
    note_id: str


class NoteBulkDeleteRequest(BaseModel):
    workspace_id: str
    note_ids: list[str]


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


class AIConfigRequest(BaseModel):
    provider: str
    model: str
    keys: dict[str, str]


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

def get_or_auth(request: Request) -> tuple[str, str, str]:
    return (
        request.headers.get("X-OpenRouter-Key", ""),
        request.headers.get("X-OpenRouter-Model", ""),
        request.headers.get("X-AI-Provider", "openrouter"),
    )


def require_auth(
    gw_session: str | None = Cookie(default=None),
    authorization: str | None = Header(default=None),
) -> None:
    if not _valid_session(gw_session) and not _valid_session(_bearer_token(authorization)):
        raise error("Authentication required", 401)


def workspace_id(value: str | None) -> str:
    selected = value or store.active_workspace()
    try:
        safe_id(selected, "workspace_id")
    except ValueError as exc:
        raise error(str(exc)) from exc
    if selected not in {item["id"] for item in store.list_workspaces()}:
        raise error("Workspace not found", 404)
    return selected


def _brain_system_prompt(workspace: str, purpose: str, context: str = "", model: str = "") -> str:
    base = (
        "You are Ghostwaiter, an intelligent personal digital assistant and brainstorming companion. "
        "Your goal is to help the user write, brainstorm, take notes, and assist with any digital tasks. "
        "You act as an all-in-one assistant for thinking, creating content, and executing digital workflows. "
        "You may respond in any language the user requests. "
        "Do not fabricate facts, do not execute system commands. "
        f"You are currently using AI model: {model}."
    )
    modes = {
        "chat": "Help the user think and discuss naturally and fluidly.",
        "write": "Write the final output directly without introductory pleasantries.",
        "rewrite": "Rewrite the text according to instructions without explaining the process.",
        "paraphrase": "Paraphrase the text while maintaining its original meaning.",
    }
    formatting = (
        "IMPORTANT: Do not use Markdown formatting symbols (like *, **, ***, ###, or ---) in your writing unless explicitly requested. "
        "Use plain text with proper paragraphs and indentation."
    )
    return f"{base}\n{modes.get(purpose, modes['write'])}\n{formatting}\n\n{context or ai_service.context(workspace)}".strip()


@app.exception_handler(HTTPException)
async def http_exception_handler(_request: Any, exc: HTTPException) -> JSONResponse:
    if isinstance(exc.detail, dict):
        payload = exc.detail
    else:
        payload = {"status": "error", "message": str(exc.detail)}
    return JSONResponse(payload, status_code=exc.status_code)


@app.head("/api/health")
@app.get("/api/health")
@app.head("/health")
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
    try:
        return next(item for item in store.list_workspaces() if item["id"] == active)
    except StopIteration:
        return {"id": active, "name": active.capitalize(), "created_at": now_iso(), "updated_at": now_iso()}


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
            "title": "New Chat",
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
        raise error("Chat not found", 404) from exc


@app.post("/api/chat/archive", dependencies=[Depends(require_auth)])
def archive_chat(req: ChatIdRequest) -> dict[str, str]:
    try:
        chat = store.get_entity(workspace_id(req.workspace_id), "chats", req.chat_id)
    except (FileNotFoundError, ValueError) as exc:
        raise error("Chat not found", 404) from exc
    chat["archived"] = True
    chat["updated_at"] = now_iso()
    store.save_entity(req.workspace_id, "chats", chat)
    return {"status": "success"}


@app.post("/api/chat/restore", dependencies=[Depends(require_auth)])
def restore_chat(req: ChatIdRequest) -> dict[str, str]:
    try:
        chat = store.get_entity(workspace_id(req.workspace_id), "chats", req.chat_id)
    except (FileNotFoundError, ValueError) as exc:
        raise error("Chat not found", 404) from exc
    chat["archived"] = False
    chat["updated_at"] = now_iso()
    store.save_entity(req.workspace_id, "chats", chat)
    return {"status": "success"}


@app.post("/api/chat/rename", dependencies=[Depends(require_auth)])
def rename_chat(req: ChatRenameRequest) -> dict[str, str]:
    try:
        chat = store.get_entity(workspace_id(req.workspace_id), "chats", req.chat_id)
    except (FileNotFoundError, ValueError) as exc:
        raise error("Chat not found", 404) from exc
    chat["title"] = " ".join(req.title.split())
    chat["updated_at"] = now_iso()
    store.save_entity(req.workspace_id, "chats", chat)
    return {"status": "success", "title": chat["title"]}


@app.post("/api/chat/delete-permanent", dependencies=[Depends(require_auth)])
def permanently_delete_chat(req: ChatIdRequest) -> dict[str, str]:
    try:
        chat = store.get_entity(workspace_id(req.workspace_id), "chats", req.chat_id)
        if not chat.get("archived"):
            raise error("Chat must be archived before permanent deletion")
        store.permanently_delete_entity(req.workspace_id, "chats", req.chat_id)
    except HTTPException:
        raise
    except (FileNotFoundError, ValueError) as exc:
        raise error("Chat not found", 404) from exc
    return {"status": "success"}


async def _analyze_chat_background(workspace: str, chat_id: str, api_key: str, model: str, provider: str = "openrouter") -> None:
    try:
        chat = store.get_entity(workspace, "chats", chat_id)
        analysis = await ai_service.analyze_chat(api_key, model, chat.get("messages", []), chat.get("summary", ""), provider=provider)
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


async def _chat_stream(workspace: str, chat: dict[str, Any], user_message: str, api_key: str, model: str, provider: str = "openrouter", attachments: list[ChatAttachment] | None = None):
    user_msg_obj = {"role": "user", "content": user_message, "timestamp": now_iso()}
    if attachments:
        user_msg_obj["attachments"] = [
            {
                "name": att.name,
                "size": att.size,
                "type": att.type,
                "content": att.content
            }
            for att in attachments
        ]
    chat["messages"].append(user_msg_obj)
    
    app_context, accessed_workspaces = build_chat_context(workspace, user_message)
    chat["accessed_workspaces"] = accessed_workspaces
    messages = [{"role": "system", "content": _brain_system_prompt(workspace, "chat", app_context, model)}]
    if chat.get("summary"):
        messages.append(
            {"role": "system", "content": f"Previous conversation summary:\n{chat['summary']}"}
        )
    
    for item in chat["messages"][-14:]:
        if item.get("role") not in {"user", "assistant"}:
            continue
        
        role = item["role"]
        content = item["content"]
        
        item_attachments = item.get("attachments", [])
        if item_attachments:
            content_list = [{"type": "text", "text": content}]
            for att in item_attachments:
                if att.get("type", "").startswith("image/"):
                    img_type = att.get("type", "image/jpeg")
                    img_data = att.get("content", "")
                    if not img_data.startswith("data:"):
                        img_data = f"data:{img_type};base64,{img_data}"
                    content_list.append({
                        "type": "image_url",
                        "image_url": {"url": img_data}
                    })
                else:
                    file_name = att.get("name", "file")
                    file_content = att.get("content", "")
                    content_list[0]["text"] += f"\n\n[Attached File: {file_name}]\n---\n{file_content}\n---"
            messages.append({"role": role, "content": content_list})
        else:
            messages.append({"role": role, "content": content})
            
    chunks: list[str] = []
    try:
        async for text in ai_service.stream(api_key, model, messages, provider=provider):
            chunks.append(text)
            yield text
    except AIUnavailable as exc:
        yield f"\n\n[Error: {exc}]"
    finally:
        answer = "".join(chunks).strip()
        if answer:
            chat["messages"].append({"role": "assistant", "content": answer, "timestamp": now_iso()})
        chat["updated_at"] = now_iso()
        if chat["title"] == "New Chat":
            chat["title"] = user_message[:60]
        store.save_entity(workspace, "chats", chat)
        if answer:
            asyncio.create_task(_analyze_chat_background(workspace, chat["id"], api_key, model, provider))


@app.post("/api/workspace/rename", dependencies=[Depends(require_auth)])
def rename_workspace(req: WorkspaceRenameRequest) -> dict[str, Any]:
    try:
        item = store.rename_workspace(req.workspace_id, req.name)
    except (ValueError, KeyError) as exc:
        raise error(str(exc), 404) from exc
    return {"status": "success", "workspace": item}

@app.post("/api/workspace/delete", dependencies=[Depends(require_auth)])
def delete_workspace(req: WorkspaceDeleteRequest) -> dict[str, str]:
    try:
        store.delete_workspace(req.workspace_id)
    except (ValueError, KeyError) as exc:
        raise error(str(exc), 404) from exc
    return {"status": "success"}

@app.post("/api/chat/send", dependencies=[Depends(require_auth)])
def send_chat(req: ChatRequest, auth: tuple[str, str, str] = Depends(get_or_auth)) -> StreamingResponse:
    workspace = workspace_id(req.workspace_id)
    if req.chat_id:
        try:
            chat = store.get_entity(workspace, "chats", req.chat_id)
        except (FileNotFoundError, ValueError) as exc:
            raise error("Chat not found", 404) from exc
        if chat.get("archived"):
            raise error("Chat is archived. Please restore it before continuing.", 409)
    else:
        chat_id = new_id("chat")
        timestamp = now_iso()
        chat = {
            "schema_version": 1,
            "id": chat_id,
            "title": "New Chat",
            "messages": [],
            "created_at": timestamp,
            "updated_at": timestamp,
            "archived": False,
            "summary": "",
            "accessed_workspaces": [],
        }
    return StreamingResponse(
        _chat_stream(workspace, chat, req.message, auth[0], auth[1], auth[2], req.attachments),
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
        raise error("Draft not found", 404) from exc
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
        raise error("Draft not found", 404) from exc


@app.post("/api/draft/delete", dependencies=[Depends(require_auth)])
def delete_draft(req: DraftIdRequest) -> dict[str, str]:
    try:
        store.delete_entity(workspace_id(req.workspace_id), "drafts", req.draft_id)
    except (FileNotFoundError, ValueError) as exc:
        raise error("Draft not found", 404) from exc
    return {"status": "success"}


@app.post("/api/notes/save", dependencies=[Depends(require_auth)])
def save_note(req: NoteSaveRequest) -> dict[str, Any]:
    workspace = workspace_id(req.workspace_id)
    timestamp = now_iso()
    note_id = req.id
    
    if not note_id:
        note_id = new_id("note")
        note = {
            "schema_version": 1,
            "id": note_id,
            "title": req.title,
            "content": req.content,
            "pinned": req.pinned,
            "tags": req.tags,
            "image": req.image,
            "created_at": timestamp,
            "updated_at": timestamp,
        }
    else:
        try:
            note = store.get_entity(workspace, "notes", note_id)
        except (FileNotFoundError, ValueError):
            note = {
                "schema_version": 1,
                "id": note_id,
                "created_at": timestamp,
            }
        note.update({
            "title": req.title,
            "content": req.content,
            "pinned": req.pinned,
            "tags": req.tags,
            "image": req.image,
            "updated_at": timestamp,
        })
        
    return store.save_entity(workspace, "notes", note)


@app.get("/api/notes/list", dependencies=[Depends(require_auth)])
def list_notes(
    workspace_id_query: str | None = Query(default=None, alias="workspace_id"),
    query: str = "",
    tag: str = "",
) -> dict[str, Any]:
    workspace = workspace_id(workspace_id_query)
    notes = store.list_entities(workspace, "notes")
    
    if query:
        needle = query.casefold()
        notes = [
            item for item in notes 
            if needle in f"{item.get('title', '')} {item.get('content', '')}".casefold()
        ]
        
    if tag:
        tag_needle = tag.casefold()
        notes = [
            item for item in notes
            if any(tag_needle == t.casefold() for t in item.get("tags", []))
        ]
        
    return {"items": notes}


@app.post("/api/notes/delete", dependencies=[Depends(require_auth)])
def delete_note(req: NoteIdRequest) -> dict[str, str]:
    workspace = workspace_id(req.workspace_id)
    try:
        store.delete_entity(workspace, "notes", req.note_id)
    except (FileNotFoundError, ValueError) as exc:
        raise error("Note not found", 404) from exc
    return {"status": "success"}


@app.post("/api/notes/delete-bulk", dependencies=[Depends(require_auth)])
def delete_notes_bulk(req: NoteBulkDeleteRequest) -> dict[str, str]:
    workspace = workspace_id(req.workspace_id)
    for note_id in req.note_ids:
        try:
            store.delete_entity(workspace, "notes", note_id)
        except (FileNotFoundError, ValueError):
            pass
    return {"status": "success"}


async def _generate_stream(workspace: str, prompt: str, mode: str, api_key: str, model: str, provider: str = "openrouter"):
    messages = [
        {"role": "system", "content": _brain_system_prompt(workspace, mode, "", model)},
        {"role": "user", "content": prompt},
    ]
    try:
        async for text in ai_service.stream(api_key, model, messages, provider=provider):
            yield text
    except AIUnavailable as exc:
        yield f"[Error: {exc}]"


@app.post("/api/ai/generate", dependencies=[Depends(require_auth)])
def generate(req: GenerateRequest, auth: tuple[str, str, str] = Depends(get_or_auth)) -> StreamingResponse:
    workspace = workspace_id(req.workspace_id)
    return StreamingResponse(
        _generate_stream(workspace, req.prompt, req.mode, auth[0], auth[1], auth[2]),
        media_type="text/plain; charset=utf-8",
        headers={"Cache-Control": "no-cache"},
    )


@app.post("/api/brain/learn/revision", dependencies=[Depends(require_auth)])
async def learn_revision(req: RevisionRequest, auth: tuple[str, str, str] = Depends(get_or_auth)) -> dict[str, Any]:
    workspace = workspace_id(req.workspace_id)
    try:
        analysis = await ai_service.learn_revision(auth[0], auth[1], req.ai_output, req.user_revision, provider=auth[2])
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
async def compare_revision(req: RevisionRequest, auth: tuple[str, str, str] = Depends(get_or_auth)) -> dict[str, Any]:
    try:
        analysis = await ai_service.learn_revision(auth[0], auth[1], req.ai_output, req.user_revision, provider=auth[2])
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
async def learn_raw(req: RawWritingRequest, auth: tuple[str, str, str] = Depends(get_or_auth)) -> dict[str, Any]:
    workspace = workspace_id(req.workspace_id)
    prompt = (
        "Analyze the following writing style. Reply with one concrete, concise style rule "
        "that can be reapplied. Do not summarize the content. "
        "Write the rule in Indonesian."
    )
    try:
        rule = (
            await ai_service.complete(
                auth[0], auth[1],
                [{"role": "system", "content": prompt}, {"role": "user", "content": req.content}],
                provider=auth[2],
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
        raise error("TAVILY_API_KEY is not configured for web search", 503)
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
        raise error("Reference not found", 404) from exc


@app.post("/api/brain/item/update", dependencies=[Depends(require_auth)])
def update_brain_item(req: BrainItemUpdateRequest) -> dict[str, str]:
    workspace = workspace_id(req.workspace_id)
    root = store.workspace_path(workspace) / "brain"
    
    if req.type == "style":
        path = root / "rules.json"
        data = store.read_json(path)
        if req.id_or_content in data.get("items", []):
            idx = data["items"].index(req.id_or_content)
            data["items"][idx] = req.new_content
            store.write_json(path, data)
    elif req.type == "thinking":
        path = root / "thinking_profile.json"
        data = store.read_json(path)
        if req.id_or_content in data.get("patterns", []):
            idx = data["patterns"].index(req.id_or_content)
            data["patterns"][idx] = req.new_content
            store.write_json(path, data)
    elif req.type == "memory":
        path = root / "memory.json"
        data = store.read_json(path)
        for item in data.get("items", []):
            if item.get("id") == req.id_or_content or item.get("content") == req.id_or_content:
                item["content"] = req.new_content
                store.write_json(path, data)
                break
    return {"status": "success"}

@app.post("/api/brain/item/delete", dependencies=[Depends(require_auth)])
def delete_brain_item(req: BrainItemDeleteRequest) -> dict[str, str]:
    workspace = workspace_id(req.workspace_id)
    root = store.workspace_path(workspace) / "brain"
    
    if req.type == "style":
        path = root / "rules.json"
        data = store.read_json(path)
        if req.id_or_content in data.get("items", []):
            data["items"].remove(req.id_or_content)
            store.write_json(path, data)
    elif req.type == "thinking":
        path = root / "thinking_profile.json"
        data = store.read_json(path)
        if req.id_or_content in data.get("patterns", []):
            data["patterns"].remove(req.id_or_content)
            store.write_json(path, data)
    elif req.type == "memory":
        path = root / "memory.json"
        data = store.read_json(path)
        data["items"] = [x for x in data.get("items", []) if x.get("id") != req.id_or_content and x.get("content") != req.id_or_content]
        store.write_json(path, data)
    return {"status": "success"}

@app.get("/api/brain/proposals", dependencies=[Depends(require_auth)])
def list_learning_proposals(
    workspace_id_query: str | None = Query(default=None, alias="workspace_id"),
    status: str = Query(default="pending", pattern="^(pending|approved|rejected|all)$"),
) -> dict[str, Any]:
    workspace = workspace_id(workspace_id_query)
    items = store.read_json(store.workspace_path(workspace) / "brain" / "learning_proposals.json").get("items", [])
    if status != "all":
        items = [item for item in items if item.get("status", "pending") == status]
    return {"items": items}


@app.post("/api/brain/proposals/approve", dependencies=[Depends(require_auth)])
def approve_learning_proposal(req: LearningProposalRequest) -> dict[str, Any]:
    workspace = workspace_id(req.workspace_id)
    path = store.workspace_path(workspace) / "brain" / "learning_proposals.json"
    data = store.read_json(path)
    proposal = next((item for item in data["items"] if item["id"] == req.proposal_id), None)
    if not proposal:
        raise error("Learning proposal not found", 404)
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
    path = store.workspace_path(workspace) / "brain" / "learning_proposals.json"
    data = store.read_json(path)
    proposal = next((item for item in data["items"] if item["id"] == req.proposal_id), None)
    if not proposal:
        raise error("Learning proposal not found", 404)
    proposal.update({"status": "rejected", "updated_at": now_iso()})
    store.write_json(path, data)
    return {"status": "success"}


@app.post("/api/brain/proposals/bulk", dependencies=[Depends(require_auth)])
def bulk_proposals(req: ProposalBulkRequest) -> dict[str, Any]:
    workspace = workspace_id(req.workspace_id)
    path = store.workspace_path(workspace) / "brain" / "learning_proposals.json"
    data = store.read_json(path)
    
    processed = 0
    for pid in req.proposal_ids:
        proposal = next((item for item in data.get("items", []) if item["id"] == pid), None)
        if not proposal:
            continue
            
        if req.action == "approve":
            content = proposal["content"].strip()
            proposal.update({"status": "approved", "updated_at": now_iso()})
            brain = store.workspace_path(workspace) / "brain"
            targets = {
                "style": (brain / "style_profile.json", "rules"),
                "thinking": (brain / "thinking_profile.json", "patterns"),
                "memory": (brain / "memory.json", "items"),
                "rule": (brain / "rules.json", "items"),
            }
            if proposal["type"] in targets:
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
                store.enqueue_sync("brain", workspace, {"proposal_id": proposal["id"], "status": "approved"})
        elif req.action == "reject":
            proposal.update({"status": "rejected", "updated_at": now_iso()})
            
        processed += 1
        
    store.write_json(path, data)
    return {"status": "success", "processed": processed}



async def _github_push_supabase() -> tuple[bool, str]:
    if not settings.github_token or not settings.github_repo:
        return False, "GITHUB_TOKEN or GITHUB_BACKUP_REPO is not configured"
    owner_repo = settings.github_repo.removeprefix("https://github.com/").removesuffix(".git").strip("/")
    if owner_repo.count("/") != 1:
        return False, "Format GITHUB_BACKUP_REPO harus owner/repo"
        
    headers = {
        "Authorization": f"Bearer {settings.github_token}",
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
    }
    
    try:
        workspaces_res = store.client.table("workspaces").select("id, data").execute()
        chats_res = store.client.table("chats").select("id, history").execute()
        drafts_res = store.client.table("drafts").select("id, content").execute()
        
        workspaces_data = []
        for ws in workspaces_res.data or []:
            ws_copy = dict(ws)
            if ws_copy.get("id") == "__system__" and isinstance(ws_copy.get("data"), dict):
                data_copy = dict(ws_copy["data"])
                data_copy.pop("ai_config", None)
                ws_copy["data"] = data_copy
            workspaces_data.append(ws_copy)
            
        backup_data = {
            "workspaces": workspaces_data,
            "chats": chats_res.data,
            "drafts": drafts_res.data,
            "timestamp": now_iso()
        }
        content = json.dumps(backup_data, ensure_ascii=False, indent=2)
    except Exception as e:
        return False, f"Failed to fetch data from Supabase: {e}"
        
    async with httpx.AsyncClient(timeout=60, headers=headers) as client:
        branch = "main"
        ref_url = f"https://api.github.com/repos/{owner_repo}/git/ref/heads/{branch}"
        ref_res = await client.get(ref_url)
        if ref_res.status_code == 404:
            branch = "master"
            ref_url = f"https://api.github.com/repos/{owner_repo}/git/ref/heads/{branch}"
            ref_res = await client.get(ref_url)
            
        if ref_res.status_code != 200:
            if ref_res.status_code == 409 or ref_res.status_code == 404:
                return False, "Repositori kosong atau tidak ada cabang main/master."
            return False, f"GitHub API (get ref): {ref_res.status_code} {ref_res.text[:200]}"
            
        commit_sha = ref_res.json()["object"]["sha"]
        
        commit_url = f"https://api.github.com/repos/{owner_repo}/git/commits/{commit_sha}"
        commit_res = await client.get(commit_url)
        if commit_res.status_code != 200:
            return False, f"GitHub API (get commit): {commit_res.status_code} {commit_res.text[:200]}"
            
        base_tree_sha = commit_res.json()["tree"]["sha"]
        
        tree = [{
            "path": "supabase_backup.json",
            "mode": "100644",
            "type": "blob",
            "content": content
        }]
        
        tree_url = f"https://api.github.com/repos/{owner_repo}/git/trees"
        tree_res = await client.post(tree_url, json={"base_tree": base_tree_sha, "tree": tree})
        if tree_res.status_code != 201:
            return False, f"GitHub API (create tree): {tree_res.status_code} {tree_res.text[:200]}"
            
        new_tree_sha = tree_res.json()["sha"]
        
        new_commit_url = f"https://api.github.com/repos/{owner_repo}/git/commits"
        new_commit_res = await client.post(new_commit_url, json={
            "message": f"Supabase Backup {datetime.now(UTC).strftime('%Y-%m-%d %H:%M:%S UTC')}",
            "tree": new_tree_sha,
            "parents": [commit_sha]
        })
        if new_commit_res.status_code != 201:
            return False, f"GitHub API (create commit): {new_commit_res.status_code} {new_commit_res.text[:200]}"
            
        new_commit_sha = new_commit_res.json()["sha"]
        
        patch_url = f"https://api.github.com/repos/{owner_repo}/git/refs/heads/{branch}"
        update_ref_res = await client.patch(patch_url, json={"sha": new_commit_sha, "force": True})
        if update_ref_res.status_code != 200:
            return False, f"GitHub API (update ref): {update_ref_res.status_code} {update_ref_res.text[:200]}"

    try:
        system = store.read_json(store.root / "system" / "settings.json", {})
        system.update({"sync_status": "ok", "last_sync": now_iso()})
        store.write_json(store.root / "system" / "settings.json", system)
    except Exception:
        pass
        
    return True, ""


async def _github_pull_supabase() -> tuple[bool, str]:
    if not settings.github_token or not settings.github_repo:
        return False, "GITHUB_TOKEN or GITHUB_BACKUP_REPO is not configured"
    owner_repo = settings.github_repo.removeprefix("https://github.com/").removesuffix(".git").strip("/")
    if owner_repo.count("/") != 1:
        return False, "Format GITHUB_BACKUP_REPO harus owner/repo"
        
    headers = {
        "Authorization": f"Bearer {settings.github_token}",
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
    }
    
    async with httpx.AsyncClient(timeout=120, headers=headers) as client:
        branch = "main"
        ref_url = f"https://api.github.com/repos/{owner_repo}/git/ref/heads/{branch}"
        ref_res = await client.get(ref_url)
        if ref_res.status_code == 404:
            branch = "master"
            ref_url = f"https://api.github.com/repos/{owner_repo}/git/ref/heads/{branch}"
            ref_res = await client.get(ref_url)
            
        if ref_res.status_code != 200:
            return False, f"GitHub API (get ref): {ref_res.status_code} {ref_res.text[:200]}"
            
        commit_sha = ref_res.json()["object"]["sha"]
        
        tree_url = f"https://api.github.com/repos/{owner_repo}/git/trees/{commit_sha}?recursive=1"
        tree_res = await client.get(tree_url)
        if tree_res.status_code != 200:
            return False, f"GitHub API (get tree): {tree_res.status_code} {tree_res.text[:200]}"
            
        tree = tree_res.json().get("tree", [])
        
        backup_item = next((item for item in tree if item["path"] == "supabase_backup.json"), None)
        if not backup_item:
            return False, "Backup file 'supabase_backup.json' not found on GitHub repository"
            
        blob_url = backup_item["url"]
        blob_res = await client.get(blob_url)
        if blob_res.status_code != 200:
            return False, f"GitHub API (get blob): {blob_res.status_code} {blob_res.text[:200]}"
            
        blob_data = blob_res.json()
        import base64
        content_str = base64.b64decode(blob_data["content"]).decode('utf-8')
        
        try:
            backup_data = json.loads(content_str)
            for item in backup_data.get("workspaces", []):
                if item["id"] == "__system__":
                    existing_res = store.client.table("workspaces").select("data").eq("id", "__system__").execute()
                    existing_ai_config = None
                    if existing_res.data:
                        existing_ai_config = existing_res.data[0].get("data", {}).get("ai_config")
                    
                    restored_data = item.get("data") or {}
                    if existing_ai_config:
                        restored_data["ai_config"] = existing_ai_config
                    store.client.table("workspaces").upsert({"id": "__system__", "data": restored_data}).execute()
                else:
                    store.client.table("workspaces").upsert({"id": item["id"], "data": item.get("data")}).execute()
            for item in backup_data.get("chats", []):
                store.client.table("chats").upsert({"id": item["id"], "history": item.get("history")}).execute()
            for item in backup_data.get("drafts", []):
                store.client.table("drafts").upsert({"id": item["id"], "content": item.get("content")}).execute()
        except Exception as e:
            return False, f"Failed to restore data to Supabase: {e}"
            
    try:
        system = store.read_json(store.root / "system" / "settings.json", {})
        system.update({"sync_status": "ok", "last_sync": now_iso()})
        store.write_json(store.root / "system" / "settings.json", system)
    except Exception:
        pass
        
    return True, ""


@app.post("/api/sync/backup-to-github", dependencies=[Depends(require_auth)])
async def backup_to_github() -> dict[str, Any]:
    ok, message = await _github_push_supabase()
    if not ok:
        raise error(message, 500)
    return {"status": "success", "message": "Backup to GitHub successful"}


@app.post("/api/sync/push", dependencies=[Depends(require_auth)])
async def run_sync_push() -> dict[str, Any]:
    ok, message = await _github_push_supabase()
    if not ok:
        raise error(message, 503)
    return {"status": "success", "last_sync": now_iso()}

@app.post("/api/sync/pull", dependencies=[Depends(require_auth)])
async def run_sync_pull() -> dict[str, Any]:
    ok, message = await _github_pull_supabase()
    if not ok:
        raise error(message, 503)
    return {"status": "success", "last_sync": now_iso()}


@app.post("/api/sync/run", dependencies=[Depends(require_auth)])
async def run_sync_combined() -> dict[str, Any]:
    if not settings.github_token or not settings.github_repo:
        raise HTTPException(status_code=400, detail="GITHUB_TOKEN or GITHUB_BACKUP_REPO is not configured")
    owner_repo = settings.github_repo.removeprefix("https://github.com/").removesuffix(".git").strip("/")
    if owner_repo.count("/") != 1:
        raise HTTPException(status_code=400, detail="Format GITHUB_BACKUP_REPO harus owner/repo")
        
    headers = {
        "Authorization": f"Bearer {settings.github_token}",
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
    }
    
    system = store.read_json(store.root / "system" / "settings.json", {})
    last_sync_str = system.get("last_sync", "")
    
    # Try fetching backup file metadata from GitHub
    async with httpx.AsyncClient(timeout=60, headers=headers) as client:
        branch = "main"
        ref_url = f"https://api.github.com/repos/{owner_repo}/git/ref/heads/{branch}"
        ref_res = await client.get(ref_url)
        if ref_res.status_code == 404:
            branch = "master"
            ref_url = f"https://api.github.com/repos/{owner_repo}/git/ref/heads/{branch}"
            ref_res = await client.get(ref_url)
            
        if ref_res.status_code != 200:
            ok, msg = await _github_push_supabase()
            if not ok:
                raise HTTPException(status_code=503, detail=f"GitHub API Error: {ref_res.status_code}. Push fallback failed: {msg}")
            return {"status": "pushed", "last_sync": now_iso(), "detail": "Repository was empty, pushed local state"}
            
        commit_sha = ref_res.json()["object"]["sha"]
        tree_url = f"https://api.github.com/repos/{owner_repo}/git/trees/{commit_sha}?recursive=1"
        tree_res = await client.get(tree_url)
        if tree_res.status_code != 200:
            raise HTTPException(status_code=502, detail=f"Failed to fetch tree: {tree_res.status_code}")
            
        tree = tree_res.json().get("tree", [])
        backup_item = next((item for item in tree if item["path"] == "supabase_backup.json"), None)
        
        if not backup_item:
            ok, msg = await _github_push_supabase()
            if not ok:
                raise HTTPException(status_code=503, detail=msg)
            return {"status": "pushed", "last_sync": now_iso(), "detail": "No backup file found on GitHub, pushed local state"}
            
        blob_res = await client.get(backup_item["url"])
        if blob_res.status_code != 200:
            raise HTTPException(status_code=502, detail="Failed to get backup file details from GitHub")
            
        blob_data = blob_res.json()
        content_str = base64.b64decode(blob_data["content"]).decode('utf-8')
        backup_data = json.loads(content_str)
        github_timestamp = backup_data.get("timestamp", "")

    def parse_iso(t_str):
        if not t_str:
            return datetime.min.replace(tzinfo=UTC)
        try:
            normalized = t_str.replace("Z", "+00:00")
            return datetime.fromisoformat(normalized)
        except Exception:
            return datetime.min.replace(tzinfo=UTC)

    git_time = parse_iso(github_timestamp)
    local_sync_time = parse_iso(last_sync_str)
    
    max_local_update = datetime.min.replace(tzinfo=UTC)
    try:
        ws_res = store.client.table("workspaces").select("data").execute()
        for r in ws_res.data or []:
            up = (r.get("data") or {}).get("updated_at")
            if up:
                t = parse_iso(up)
                if t > max_local_update:
                    max_local_update = t
                    
        chats_res = store.client.table("chats").select("history").execute()
        for r in chats_res.data or []:
            up = (r.get("history") or {}).get("updated_at")
            if up:
                t = parse_iso(up)
                if t > max_local_update:
                    max_local_update = t
                    
        drafts_res = store.client.table("drafts").select("content").execute()
        for r in drafts_res.data or []:
            up = (r.get("content") or {}).get("updated_at")
            if up:
                t = parse_iso(up)
                if t > max_local_update:
                    max_local_update = t
    except Exception:
        pass
        
    if git_time > local_sync_time and git_time > max_local_update:
        try:
            for item in backup_data.get("workspaces", []):
                if item["id"] == "__system__":
                    existing_res = store.client.table("workspaces").select("data").eq("id", "__system__").execute()
                    existing_ai_config = None
                    if existing_res.data:
                        existing_ai_config = existing_res.data[0].get("data", {}).get("ai_config")
                    
                    restored_data = item.get("data") or {}
                    if existing_ai_config:
                        restored_data["ai_config"] = existing_ai_config
                    store.client.table("workspaces").upsert({"id": "__system__", "data": restored_data}).execute()
                else:
                    store.client.table("workspaces").upsert({"id": item["id"], "data": item.get("data")}).execute()
            for item in backup_data.get("chats", []):
                store.client.table("chats").upsert({"id": item["id"], "history": item.get("history")}).execute()
            for item in backup_data.get("drafts", []):
                store.client.table("drafts").upsert({"id": item["id"], "content": item.get("content")}).execute()
                
            system.update({"sync_status": "ok", "last_sync": github_timestamp})
            store.write_json(store.root / "system" / "settings.json", system)
        except Exception as e:
            raise HTTPException(status_code=500, detail=f"Failed to restore pulled backup: {e}")
        return {"status": "pulled", "last_sync": github_timestamp, "detail": "Pulled newer backup from GitHub"}
        
    elif max_local_update > git_time or max_local_update > local_sync_time:
        ok, msg = await _github_push_supabase()
        if not ok:
            raise HTTPException(status_code=503, detail=msg)
        return {"status": "pushed", "last_sync": now_iso(), "detail": "Pushed newer local changes to GitHub"}
        
    else:
        try:
            system.update({"sync_status": "ok", "last_sync": last_sync_str if last_sync_str else github_timestamp})
            store.write_json(store.root / "system" / "settings.json", system)
        except Exception:
            pass
        return {"status": "synced", "last_sync": last_sync_str if last_sync_str else github_timestamp, "detail": "All data is up to date"}


@app.get("/api/sync/status", dependencies=[Depends(require_auth)])
def sync_status() -> dict[str, Any]:
    try:
        if not settings.supabase_url or not settings.supabase_key or store.client.__class__.__name__ == "MockSupabaseClient":
            supabase_connected = False
        else:
            store.client.table("workspaces").select("id").limit(1).execute()
            supabase_connected = True
    except Exception as e:
        print(f"Supabase connection check failed: {e}", flush=True)
        supabase_connected = False

    return {
        "supabase_configured": bool(settings.supabase_url and settings.supabase_key),
        "supabase_connected": supabase_connected,
    }


@app.get("/api/ai/config", dependencies=[Depends(require_auth)])
def get_ai_config() -> dict[str, Any]:
    try:
        res = store.client.table("workspaces").select("data").eq("id", "__system__").execute()
        if res.data:
            data = res.data[0].get("data") or {}
            return data.get("ai_config") or {"provider": "", "model": "", "keys": {}}
    except Exception as e:
        print(f"Failed to get AI config: {e}", flush=True)
    return {"provider": "", "model": "", "keys": {}}


@app.post("/api/ai/config", dependencies=[Depends(require_auth)])
def save_ai_config(req: AIConfigRequest) -> dict[str, str]:
    try:
        res = store.client.table("workspaces").select("data").eq("id", "__system__").execute()
        current_data = {}
        if res.data:
            current_data = res.data[0].get("data") or {}
        current_data["ai_config"] = req.model_dump()
        store.client.table("workspaces").upsert({"id": "__system__", "data": current_data}).execute()
        return {"status": "success"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to save AI config: {e}")


@app.get("/api/sync/queue", dependencies=[Depends(require_auth)])
def sync_queue() -> dict[str, Any]:
    return store.read_json(store.root / "queue" / "pending_sync.json", {})


@app.post("/api/sync/retry", dependencies=[Depends(require_auth)])
async def retry_sync() -> dict[str, Any]:
    ok, message = await _github_push_supabase()
    if not ok:
        raise error(message, 503)
    return {"status": "success", "last_sync": now_iso()}


@app.post("/api/ai/test-connection", dependencies=[Depends(require_auth)])
async def test_ai_connection(request: Request) -> dict[str, Any]:
    api_key, model, provider = get_or_auth(request)
    connected, message = await ai_service.test_connection(api_key, model, provider)
    return {"connected": connected, "message": message}


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
        raise error("Snapshot not found", 404) from exc
    return FileResponse(path, media_type="application/zip", filename=path.name)


@app.post("/api/snapshot/restore", dependencies=[Depends(require_auth)])
def restore_snapshot(req: SnapshotRestoreRequest) -> dict[str, str]:
    try:
        path = store.snapshot_path(req.snapshot_id)
    except FileNotFoundError as exc:
        raise error("Snapshot not found", 404) from exc
    store.create_snapshot()
    with zipfile.ZipFile(path) as archive:
        root = store.root.resolve()
        for member in archive.infolist():
            target = (root / member.filename).resolve()
            if root not in target.parents and target != root:
                raise error("Snapshot contains an unsafe path")
                
        try:
            content_bytes = archive.read("supabase_backup.json")
            backup_data = json.loads(content_bytes.decode("utf-8"))
            
            # Read existing ai_config to preserve it
            existing_res = store.client.table("workspaces").select("data").eq("id", "__system__").execute()
            existing_ai_config = None
            if existing_res.data:
                existing_ai_config = existing_res.data[0].get("data", {}).get("ai_config")
                
            for item in backup_data.get("workspaces", []):
                restored_data = item.get("data") or {}
                if item["id"] == "__system__":
                    if existing_ai_config:
                        restored_data["ai_config"] = existing_ai_config
                store.client.table("workspaces").upsert({"id": item["id"], "data": restored_data}).execute()
            for item in backup_data.get("chats", []):
                store.client.table("chats").upsert({"id": item["id"], "history": item.get("history")}).execute()
            for item in backup_data.get("drafts", []):
                store.client.table("drafts").upsert({"id": item["id"], "content": item.get("content")}).execute()
        except Exception as e:
            raise error(f"Failed to restore database from snapshot: {e}", 500)
            
        archive.extractall(store.root)
    return {"status": "success"}


@app.get("/api/export", dependencies=[Depends(require_auth)])
def export_data() -> StreamingResponse:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
        for path in store.root.rglob("*.json"):
            archive.write(path, path.relative_to(store.root))
    buffer.seek(0)
    filename = f"ghostwaiter_{datetime.now(UTC).strftime('%Y%m%d_%H%M%S')}.zip"
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
            raise error("Zip file is corrupted or invalid")
            
        workspaces_dir = tmp_path / "workspaces"
        if not workspaces_dir.exists() or not workspaces_dir.is_dir():
            raise error("No workspaces folder found in the zip")
            
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


@app.head("/", include_in_schema=False)
@app.get("/", include_in_schema=False)
def index() -> FileResponse:
    return FileResponse(FRONTEND_DIR / "index.html")
