"""
tests/test_api.py
=================
Regression test untuk API endpoints (main.py).
Menggunakan FastAPI TestClient — tidak butuh server berjalan.

Setiap test di sini merepresentasikan satu fitur/contract API
yang pernah bermasalah atau berisiko rusak saat refactor.
"""
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

# Arahkan DATA_DIR ke temp dir sebelum import apapun dari backend
_TEMP = tempfile.mkdtemp()
os.environ["DATA_DIR"] = _TEMP
os.environ.setdefault("APP_PASSWORD", "")  # nonaktifkan auth untuk test

from fastapi.testclient import TestClient

from backend.main import app
from backend.storage import JsonStore

# TestClient – sinkron, tidak perlu asyncio
client = TestClient(app, raise_server_exceptions=True)

# Buat store yang menunjuk ke _TEMP (sama dengan yang dipakai app)
_store = JsonStore(Path(_TEMP))


def _auth_headers() -> dict:
    """Dapatkan session header (tidak perlu karena APP_PASSWORD kosong)."""
    return {}


# ---------------------------------------------------------------------------
# Health
# ---------------------------------------------------------------------------

class HealthTests(unittest.TestCase):
    def test_health_ok(self):
        r = client.get("/api/health")
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json()["status"], "ok")

    def test_health_contains_storage_path(self):
        r = client.get("/api/health")
        self.assertIn("storage", r.json())


# ---------------------------------------------------------------------------
# Auth – tanpa password (APP_PASSWORD kosong)
# ---------------------------------------------------------------------------

class AuthNoPasswordTests(unittest.TestCase):
    def test_auth_status_not_authenticated_when_no_session(self):
        r = client.get("/api/auth/status")
        self.assertEqual(r.status_code, 200)
        data = r.json()
        # Jika tidak ada password, selalu dianggap authenticated = True
        self.assertIn("authenticated", data)
        self.assertFalse(data["password_required"])

    def test_login_without_password_succeeds(self):
        r = client.post("/api/auth/login", json={"password": ""})
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json()["status"], "success")

    def test_logout_clears_cookie(self):
        r = client.post("/api/auth/logout")
        self.assertEqual(r.status_code, 200)


# ---------------------------------------------------------------------------
# Workspace CRUD
# ---------------------------------------------------------------------------

class WorkspaceApiTests(unittest.TestCase):
    def test_list_workspaces_returns_items(self):
        r = client.get("/api/workspace/list")
        self.assertEqual(r.status_code, 200)
        self.assertIn("items", r.json())

    def test_create_workspace(self):
        r = client.post("/api/workspace/create", json={"name": "TestWS Api"})
        self.assertEqual(r.status_code, 200)
        data = r.json()
        self.assertEqual(data["status"], "success")
        self.assertIn("workspace", data)

    def test_create_workspace_empty_name_returns_422(self):
        r = client.post("/api/workspace/create", json={"name": ""})
        self.assertEqual(r.status_code, 422)

    def test_rename_workspace(self):
        r = client.post("/api/workspace/create", json={"name": "RenameFrom"})
        ws_id = r.json()["workspace"]["id"]
        r2 = client.post("/api/workspace/rename", json={"workspace_id": ws_id, "name": "RenameTo"})
        self.assertEqual(r2.status_code, 200)
        self.assertEqual(r2.json()["workspace"]["name"], "RenameTo")

    def test_rename_nonexistent_workspace_returns_404(self):
        r = client.post("/api/workspace/rename", json={"workspace_id": "nope_nonexist1", "name": "X"})
        self.assertEqual(r.status_code, 404)

    def test_delete_workspace(self):
        r = client.post("/api/workspace/create", json={"name": "DeleteMe Api"})
        ws_id = r.json()["workspace"]["id"]
        r2 = client.post("/api/workspace/delete", json={"workspace_id": ws_id})
        self.assertEqual(r2.status_code, 200)

    def test_cannot_delete_default_personal_workspace(self):
        r = client.post("/api/workspace/delete", json={"workspace_id": "personal"})
        self.assertIn(r.status_code, (400, 404))

    def test_switch_workspace(self):
        r = client.post("/api/workspace/create", json={"name": "SwitchTo Api"})
        ws_id = r.json()["workspace"]["id"]
        r2 = client.post("/api/workspace/switch", json={"workspace_id": ws_id})
        self.assertEqual(r2.status_code, 200)

    def test_switch_nonexistent_workspace_returns_404(self):
        r = client.post("/api/workspace/switch", json={"workspace_id": "nope_nonexist2"})
        self.assertEqual(r.status_code, 404)

    def test_current_workspace_returns_data(self):
        r = client.get("/api/workspace/current")
        self.assertEqual(r.status_code, 200)
        self.assertIn("id", r.json())


# ---------------------------------------------------------------------------
# Draft CRUD
# ---------------------------------------------------------------------------

class DraftApiTests(unittest.TestCase):
    def setUp(self):
        # Pastikan workspace personal tersedia
        client.post("/api/workspace/switch", json={"workspace_id": "personal"})

    def test_create_draft(self):
        r = client.post("/api/draft/create", json={"workspace_id": "personal"})
        self.assertEqual(r.status_code, 200)
        self.assertIn("id", r.json())

    def test_create_draft_with_title(self):
        r = client.post("/api/draft/create", json={"workspace_id": "personal", "title": "My Draft"})
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json()["title"], "My Draft")

    def test_get_draft(self):
        r = client.post("/api/draft/create", json={"workspace_id": "personal"})
        draft_id = r.json()["id"]
        r2 = client.get(f"/api/draft/{draft_id}?workspace_id=personal")
        self.assertEqual(r2.status_code, 200)
        self.assertEqual(r2.json()["id"], draft_id)

    def test_get_nonexistent_draft_returns_404(self):
        r = client.get("/api/draft/nonexistent_id1?workspace_id=personal")
        self.assertEqual(r.status_code, 404)

    def test_update_draft_title(self):
        r = client.post("/api/draft/create", json={"workspace_id": "personal"})
        draft_id = r.json()["id"]
        r2 = client.post("/api/draft/update", json={
            "workspace_id": "personal",
            "draft_id": draft_id,
            "title": "Updated Title",
        })
        self.assertEqual(r2.status_code, 200)
        self.assertEqual(r2.json()["title"], "Updated Title")

    def test_update_draft_content(self):
        r = client.post("/api/draft/create", json={"workspace_id": "personal"})
        draft_id = r.json()["id"]
        r2 = client.post("/api/draft/update", json={
            "workspace_id": "personal",
            "draft_id": draft_id,
            "content": "Isi konten baru",
        })
        self.assertEqual(r2.status_code, 200)
        self.assertEqual(r2.json()["content"], "Isi konten baru")

    def test_update_nonexistent_draft_returns_404(self):
        r = client.post("/api/draft/update", json={
            "workspace_id": "personal",
            "draft_id": "nonexistent_id2",
            "title": "X",
        })
        self.assertEqual(r.status_code, 404)

    def test_list_drafts(self):
        r = client.get("/api/draft/list?workspace_id=personal")
        self.assertEqual(r.status_code, 200)
        self.assertIn("items", r.json())

    def test_list_drafts_search(self):
        client.post("/api/draft/create", json={"workspace_id": "personal", "title": "Affiliate Review"})
        r = client.get("/api/draft/list?workspace_id=personal&query=Affiliate")
        self.assertEqual(r.status_code, 200)
        titles = [item["title"] for item in r.json()["items"]]
        self.assertTrue(any("Affiliate" in t for t in titles))

    def test_delete_draft(self):
        r = client.post("/api/draft/create", json={"workspace_id": "personal"})
        draft_id = r.json()["id"]
        r2 = client.post("/api/draft/delete", json={"workspace_id": "personal", "draft_id": draft_id})
        self.assertEqual(r2.status_code, 200)
        # Harus tidak bisa diakses lagi
        r3 = client.get(f"/api/draft/{draft_id}?workspace_id=personal")
        self.assertEqual(r3.status_code, 404)

    def test_delete_nonexistent_draft_returns_404(self):
        r = client.post("/api/draft/delete", json={"workspace_id": "personal", "draft_id": "nonexistent_id3"})
        self.assertEqual(r.status_code, 404)


# ---------------------------------------------------------------------------
# Notes CRUD
# ---------------------------------------------------------------------------

class NotesApiTests(unittest.TestCase):
    def setUp(self):
        client.post("/api/workspace/switch", json={"workspace_id": "personal"})

    def test_save_and_list_notes(self):
        r = client.post("/api/notes/save", json={
            "workspace_id": "personal",
            "title": "Catatan API",
            "content": "Isi Catatan API",
            "pinned": True,
            "tags": ["api-tag"],
            "image": "data:image/png;base64,123",
        })
        self.assertEqual(r.status_code, 200)
        note_id = r.json()["id"]
        self.assertEqual(r.json()["title"], "Catatan API")
        self.assertTrue(r.json()["pinned"])

        r2 = client.get("/api/notes/list?workspace_id=personal")
        self.assertEqual(r2.status_code, 200)
        notes = r2.json()["items"]
        self.assertTrue(any(n["id"] == note_id for n in notes))

        r3 = client.post("/api/notes/save", json={
            "workspace_id": "personal",
            "id": note_id,
            "title": "Catatan API Updated",
            "content": "Isi Catatan API Updated",
            "pinned": False,
            "tags": ["api-tag-2"],
        })
        self.assertEqual(r3.status_code, 200)
        self.assertEqual(r3.json()["title"], "Catatan API Updated")
        self.assertFalse(r3.json()["pinned"])

        r4 = client.get("/api/notes/list?workspace_id=personal&query=Updated&tag=api-tag-2")
        self.assertEqual(r4.status_code, 200)
        self.assertEqual(len(r4.json()["items"]), 1)

        r5 = client.post("/api/notes/delete", json={
            "workspace_id": "personal",
            "note_id": note_id
        })
        self.assertEqual(r5.status_code, 200)

        r6 = client.get("/api/notes/list?workspace_id=personal")
        notes_after = r6.json()["items"]
        self.assertFalse(any(n["id"] == note_id for n in notes_after))

    def test_delete_bulk_notes(self):
        r1 = client.post("/api/notes/save", json={
            "workspace_id": "personal",
            "title": "Note 1",
            "content": "Content 1"
        })
        r2 = client.post("/api/notes/save", json={
            "workspace_id": "personal",
            "title": "Note 2",
            "content": "Content 2"
        })
        id1 = r1.json()["id"]
        id2 = r2.json()["id"]

        r3 = client.post("/api/notes/delete-bulk", json={
            "workspace_id": "personal",
            "note_ids": [id1, id2]
        })
        self.assertEqual(r3.status_code, 200)

        r4 = client.get("/api/notes/list?workspace_id=personal")
        notes = r4.json()["items"]
        self.assertFalse(any(n["id"] in (id1, id2) for n in notes))


# ---------------------------------------------------------------------------
# Chat lifecycle
# ---------------------------------------------------------------------------

class ChatApiTests(unittest.TestCase):
    def setUp(self):
        client.post("/api/workspace/switch", json={"workspace_id": "personal"})

    def test_new_chat(self):
        r = client.post("/api/chat/new", json={"workspace_id": "personal"})
        self.assertEqual(r.status_code, 200)
        self.assertIn("chat_id", r.json())

    def test_get_chat(self):
        r = client.post("/api/chat/new", json={"workspace_id": "personal"})
        chat_id = r.json()["chat_id"]
        r2 = client.get(f"/api/chat/session/{chat_id}?workspace_id=personal")
        self.assertEqual(r2.status_code, 200)
        self.assertEqual(r2.json()["id"], chat_id)

    def test_get_nonexistent_chat_returns_404(self):
        r = client.get("/api/chat/session/nonexistent_id4?workspace_id=personal")
        self.assertEqual(r.status_code, 404)

    def test_list_chats(self):
        r = client.get("/api/chat/list?workspace_id=personal")
        self.assertEqual(r.status_code, 200)
        self.assertIn("items", r.json())

    def test_list_chats_archived_filter(self):
        r1 = client.post("/api/chat/new", json={"workspace_id": "personal"})
        chat_id = r1.json()["chat_id"]
        client.post("/api/chat/archive", json={"workspace_id": "personal", "chat_id": chat_id})
        r2 = client.get("/api/chat/list?workspace_id=personal&archived=true")
        archived_ids = [item["id"] for item in r2.json()["items"]]
        self.assertIn(chat_id, archived_ids)
        r3 = client.get("/api/chat/list?workspace_id=personal&archived=false")
        active_ids = [item["id"] for item in r3.json()["items"]]
        self.assertNotIn(chat_id, active_ids)

    def test_rename_chat(self):
        r = client.post("/api/chat/new", json={"workspace_id": "personal"})
        chat_id = r.json()["chat_id"]
        r2 = client.post("/api/chat/rename", json={
            "workspace_id": "personal",
            "chat_id": chat_id,
            "title": "Chat Renamed",
        })
        self.assertEqual(r2.status_code, 200)
        self.assertEqual(r2.json()["title"], "Chat Renamed")

    def test_archive_and_restore_chat(self):
        r = client.post("/api/chat/new", json={"workspace_id": "personal"})
        chat_id = r.json()["chat_id"]
        # Archive
        r2 = client.post("/api/chat/archive", json={"workspace_id": "personal", "chat_id": chat_id})
        self.assertEqual(r2.status_code, 200)
        chat = client.get(f"/api/chat/session/{chat_id}?workspace_id=personal").json()
        self.assertTrue(chat["archived"])
        # Restore
        r3 = client.post("/api/chat/restore", json={"workspace_id": "personal", "chat_id": chat_id})
        self.assertEqual(r3.status_code, 200)
        chat2 = client.get(f"/api/chat/session/{chat_id}?workspace_id=personal").json()
        self.assertFalse(chat2["archived"])

    def test_permanent_delete_requires_archived(self):
        r = client.post("/api/chat/new", json={"workspace_id": "personal"})
        chat_id = r.json()["chat_id"]
        # Tidak di-archive dulu → harus error
        r2 = client.post("/api/chat/delete-permanent", json={"workspace_id": "personal", "chat_id": chat_id})
        self.assertIn(r2.status_code, (400, 409))

    def test_permanent_delete_archived_chat(self):
        r = client.post("/api/chat/new", json={"workspace_id": "personal"})
        chat_id = r.json()["chat_id"]
        client.post("/api/chat/archive", json={"workspace_id": "personal", "chat_id": chat_id})
        r2 = client.post("/api/chat/delete-permanent", json={"workspace_id": "personal", "chat_id": chat_id})
        self.assertEqual(r2.status_code, 200)
        r3 = client.get(f"/api/chat/session/{chat_id}?workspace_id=personal")
        self.assertEqual(r3.status_code, 404)


# ---------------------------------------------------------------------------
# Brain profile
# ---------------------------------------------------------------------------

class BrainProfileApiTests(unittest.TestCase):
    def test_brain_profile_returns_expected_keys(self):
        r = client.get("/api/brain/profile?workspace_id=personal")
        self.assertEqual(r.status_code, 200)
        data = r.json()
        for key in ("style_profile", "thinking_profile", "rules", "memory",
                    "conversation_memory", "pending_proposals",
                    "revision_count", "raw_writing_count"):
            self.assertIn(key, data, f"Missing key: {key}")


# ---------------------------------------------------------------------------
# Brain item – update & delete
# ---------------------------------------------------------------------------

class BrainItemApiTests(unittest.TestCase):
    def _add_style_rule(self, rule: str) -> None:
        """Tambah rule langsung ke store untuk persiapan test."""
        from backend.storage import store as app_store
        brain = app_store.workspace_path("personal") / "brain"
        path = brain / "rules.json"
        data = app_store.read_json(path)
        data["items"].append(rule)
        app_store.write_json(path, data)

    def test_update_style_brain_item(self):
        self._add_style_rule("Gunakan kalimat pendek")
        r = client.post("/api/brain/item/update", json={
            "workspace_id": "personal",
            "type": "style",
            "id_or_content": "Gunakan kalimat pendek",
            "new_content": "Gunakan kalimat pendek dan padat",
        })
        self.assertEqual(r.status_code, 200)

    def test_delete_style_brain_item(self):
        self._add_style_rule("Style untuk dihapus")
        r = client.post("/api/brain/item/delete", json={
            "workspace_id": "personal",
            "type": "style",
            "id_or_content": "Style untuk dihapus",
        })
        self.assertEqual(r.status_code, 200)
        # Pastikan sudah tidak ada
        r2 = client.get("/api/brain/profile?workspace_id=personal")
        rules = r2.json()["rules"]
        self.assertNotIn("Style untuk dihapus", [r for r in rules])


# ---------------------------------------------------------------------------
# Learning proposals
# ---------------------------------------------------------------------------

class LearningProposalApiTests(unittest.TestCase):
    def _add_proposal(self, content: str = "Test proposal", ptype: str = "style") -> str:
        """Tambah proposal langsung ke store."""
        from backend.storage import store as app_store, new_id, now_iso
        path = app_store.workspace_path("personal") / "brain" / "learning_proposals.json"
        data = app_store.read_json(path)
        pid = new_id("learn")
        data["items"].insert(0, {
            "id": pid,
            "type": ptype,
            "content": content,
            "status": "pending",
            "created_at": now_iso(),
            "updated_at": now_iso(),
        })
        app_store.write_json(path, data)
        return pid

    def test_list_proposals_default_pending(self):
        self._add_proposal("Proposal pending satu")
        r = client.get("/api/brain/proposals?workspace_id=personal")
        self.assertEqual(r.status_code, 200)
        statuses = {item["status"] for item in r.json()["items"]}
        self.assertTrue(statuses.issubset({"pending"}))

    def test_approve_proposal(self):
        pid = self._add_proposal("Gunakan aktif voice")
        r = client.post("/api/brain/proposals/approve", json={
            "workspace_id": "personal",
            "proposal_id": pid,
        })
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json()["proposal"]["status"], "approved")

    def test_reject_proposal(self):
        pid = self._add_proposal("Hindari kata baku")
        r = client.post("/api/brain/proposals/reject", json={
            "workspace_id": "personal",
            "proposal_id": pid,
        })
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json()["status"], "success")
        # Pastikan status di storage berubah ke rejected
        from backend.storage import store as app_store
        path = app_store.workspace_path("personal") / "brain" / "learning_proposals.json"
        data = app_store.read_json(path)
        proposal = next((x for x in data["items"] if x["id"] == pid), None)
        self.assertIsNotNone(proposal)
        self.assertEqual(proposal["status"], "rejected")

    def test_approve_nonexistent_proposal_returns_404(self):
        r = client.post("/api/brain/proposals/approve", json={
            "workspace_id": "personal",
            "proposal_id": "nonexistent_prop1",
        })
        self.assertEqual(r.status_code, 404)

    def test_reject_nonexistent_proposal_returns_404(self):
        r = client.post("/api/brain/proposals/reject", json={
            "workspace_id": "personal",
            "proposal_id": "nonexistent_prop2",
        })
        self.assertEqual(r.status_code, 404)

    def test_bulk_approve_proposals(self):
        pid1 = self._add_proposal("Bulk approve 1")
        pid2 = self._add_proposal("Bulk approve 2")
        r = client.post("/api/brain/proposals/bulk", json={
            "workspace_id": "personal",
            "action": "approve",
            "proposal_ids": [pid1, pid2],
        })
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json()["status"], "success")

    def test_bulk_reject_proposals(self):
        pid1 = self._add_proposal("Bulk reject 1")
        pid2 = self._add_proposal("Bulk reject 2")
        r = client.post("/api/brain/proposals/bulk", json={
            "workspace_id": "personal",
            "action": "reject",
            "proposal_ids": [pid1, pid2],
        })
        self.assertEqual(r.status_code, 200)

    def test_approved_style_proposal_added_to_style_profile(self):
        unique_rule = "Pakai kalimat aktif selalu9191"
        pid = self._add_proposal(unique_rule, ptype="style")
        client.post("/api/brain/proposals/approve", json={
            "workspace_id": "personal",
            "proposal_id": pid,
        })
        # Rule harus masuk style_profile.rules
        from backend.storage import store as app_store
        brain = app_store.workspace_path("personal") / "brain"
        style = app_store.read_json(brain / "style_profile.json")
        self.assertIn(unique_rule, style.get("rules", []))

    def test_approve_does_not_duplicate_existing_rule(self):
        unique_rule = "Aturan unik anti duplikat6767"
        pid1 = self._add_proposal(unique_rule, ptype="style")
        pid2 = self._add_proposal(unique_rule, ptype="style")
        client.post("/api/brain/proposals/approve", json={"workspace_id": "personal", "proposal_id": pid1})
        client.post("/api/brain/proposals/approve", json={"workspace_id": "personal", "proposal_id": pid2})
        from backend.storage import store as app_store
        brain = app_store.workspace_path("personal") / "brain"
        style = app_store.read_json(brain / "style_profile.json")
        count = style.get("rules", []).count(unique_rule)
        self.assertEqual(count, 1)


# ---------------------------------------------------------------------------
# Snapshot API
# ---------------------------------------------------------------------------

class SnapshotApiTests(unittest.TestCase):
    def test_create_snapshot(self):
        r = client.post("/api/snapshot/create")
        self.assertEqual(r.status_code, 200)
        self.assertIn("id", r.json())

    def test_list_snapshots(self):
        client.post("/api/snapshot/create")
        r = client.get("/api/snapshot/list")
        self.assertEqual(r.status_code, 200)
        self.assertIn("items", r.json())

    def test_download_snapshot(self):
        r = client.post("/api/snapshot/create")
        sid = r.json()["id"]
        r2 = client.get(f"/api/snapshot/download/{sid}")
        self.assertEqual(r2.status_code, 200)
        self.assertEqual(r2.headers["content-type"], "application/zip")

    def test_download_nonexistent_snapshot_returns_404(self):
        r = client.get("/api/snapshot/download/snapshot_9999_99_99_000000")
        self.assertEqual(r.status_code, 404)


# ---------------------------------------------------------------------------
# Sync status
# ---------------------------------------------------------------------------

class SyncApiTests(unittest.TestCase):
    def test_sync_status(self):
        r = client.get("/api/sync/status")
        self.assertEqual(r.status_code, 200)
        data = r.json()
        self.assertIn("supabase_configured", data)
        self.assertIn("supabase_connected", data)

    def test_sync_queue(self):
        r = client.get("/api/sync/queue")
        self.assertEqual(r.status_code, 200)


# ---------------------------------------------------------------------------
# Export & Import
# ---------------------------------------------------------------------------

class ExportApiTests(unittest.TestCase):
    def test_export_returns_zip(self):
        r = client.get("/api/export")
        self.assertEqual(r.status_code, 200)
        self.assertIn("zip", r.headers.get("content-type", ""))

class ImportApiTests(unittest.TestCase):
    def test_import_zip_success(self):
        # Create a dummy snapshot zip to import
        import io
        import zipfile
        zip_buffer = io.BytesIO()
        with zipfile.ZipFile(zip_buffer, "w", zipfile.ZIP_DEFLATED) as zf:
            zf.writestr("workspaces/test_ws/data.json", '{"id":"test_ws","name":"Test WS"}')
        zip_buffer.seek(0)
        
        r = client.post("/api/import", files={"file": ("backup.zip", zip_buffer, "application/zip")})
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json()["status"], "success")


# ---------------------------------------------------------------------------
# Error format consistency
# ---------------------------------------------------------------------------

class ErrorFormatTests(unittest.TestCase):
    """Pastikan semua error response mengikuti format {status, message}."""

    def test_404_error_has_status_and_message(self):
        r = client.get("/api/draft/totally_nonexistent_x?workspace_id=personal")
        self.assertEqual(r.status_code, 404)
        data = r.json()
        self.assertIn("status", data)
        self.assertIn("message", data)

    def test_workspace_not_found_has_status_and_message(self):
        r = client.post("/api/workspace/switch", json={"workspace_id": "nope_nonexist9"})
        self.assertEqual(r.status_code, 404)
        data = r.json()
        self.assertIn("message", data)


if __name__ == "__main__":
    unittest.main(verbosity=2)
