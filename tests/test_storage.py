"""
tests/test_storage.py
====================
Test suite untuk JsonStore dan context builder.
Tujuan: mencegah regresi bug yang pernah diperbaiki.
"""
import tempfile
import unittest
from pathlib import Path

from backend.storage import JsonStore, new_id, safe_id
import backend.context as context_module


# ---------------------------------------------------------------------------
# safe_id
# ---------------------------------------------------------------------------

class SafeIdTests(unittest.TestCase):
    def test_valid_ids_pass(self):
        for value in ("personal", "chat_123", "abc-def", "a1B2", "x" * 64):
            self.assertEqual(safe_id(value), value)

    def test_rejects_path_traversal(self):
        with self.assertRaises(ValueError):
            safe_id("../../etc/passwd")

    def test_rejects_slash(self):
        with self.assertRaises(ValueError):
            safe_id("foo/bar")

    def test_rejects_empty_string(self):
        with self.assertRaises(ValueError):
            safe_id("")

    def test_rejects_dot_only(self):
        with self.assertRaises(ValueError):
            safe_id(".")

    def test_rejects_too_long(self):
        with self.assertRaises(ValueError):
            safe_id("a" * 65)

    def test_custom_label_in_error(self):
        try:
            safe_id("bad/id", "workspace_id")
        except ValueError as exc:
            self.assertIn("workspace_id", str(exc))

    def test_starts_with_special_char_rejected(self):
        with self.assertRaises(ValueError):
            safe_id("-invalid")


# ---------------------------------------------------------------------------
# new_id
# ---------------------------------------------------------------------------

class NewIdTests(unittest.TestCase):
    def test_format(self):
        generated = new_id("chat")
        self.assertTrue(generated.startswith("chat_"))
        self.assertEqual(len(generated), len("chat_") + 12)

    def test_uniqueness(self):
        ids = {new_id("x") for _ in range(100)}
        self.assertEqual(len(ids), 100)


# ---------------------------------------------------------------------------
# JsonStore – inisialisasi & workspace default
# ---------------------------------------------------------------------------

class JsonStoreInitTests(unittest.TestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.store = JsonStore(Path(self.tempdir.name))

    def tearDown(self):
        self.tempdir.cleanup()

    def test_default_workspace_is_personal(self):
        self.assertEqual(self.store.active_workspace(), "personal")

    def test_default_workspace_brain_files_exist(self):
        brain = self.store.workspace_path("personal") / "brain"
        for fname in (
            "style_profile.json",
            "thinking_profile.json",
            "memory.json",
            "rules.json",
            "conversation_memory.json",
            "learning_proposals.json",
        ):
            self.assertTrue((brain / fname).exists(), f"Missing {fname}")

    def test_default_workspace_summary_exists(self):
        summary = self.store.workspace_path("personal") / "summary" / "workspace_summary.json"
        self.assertTrue(summary.exists())

    def test_system_files_initialized(self):
        for fname in ("settings.json", "workspaces.json", "models.json"):
            self.assertTrue((self.store.root / "system" / fname).exists())

    def test_queue_initialized(self):
        self.assertTrue((self.store.root / "queue" / "pending_sync.json").exists())

    def test_reinitialize_does_not_overwrite_existing(self):
        """Memanggil __init__ ulang tidak boleh menghapus data yang sudah ada."""
        self.store.create_workspace("KeepMe")
        # Buat store baru dengan root yang sama (simulasi restart)
        store2 = JsonStore(Path(self.tempdir.name))
        ids = {ws["id"] for ws in store2.list_workspaces()}
        self.assertIn("keepme", ids)


# ---------------------------------------------------------------------------
# JsonStore – CRUD entity
# ---------------------------------------------------------------------------

class EntityCRUDTests(unittest.TestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.store = JsonStore(Path(self.tempdir.name))

    def tearDown(self):
        self.tempdir.cleanup()

    def test_save_and_get_entity(self):
        draft = {"id": "draft_abc", "title": "Hello", "content": "World"}
        self.store.save_entity("personal", "drafts", draft)
        result = self.store.get_entity("personal", "drafts", "draft_abc")
        self.assertEqual(result["title"], "Hello")

    def test_save_and_get_note_entity(self):
        note = {"id": "note_123", "title": "Catatan", "content": "Isi Catatan", "pinned": True, "tags": ["tag1"]}
        self.store.save_entity("personal", "notes", note)
        result = self.store.get_entity("personal", "notes", "note_123")
        self.assertEqual(result["title"], "Catatan")
        self.assertEqual(result["content"], "Isi Catatan")
        self.assertTrue(result["pinned"])
        self.assertEqual(result["tags"], ["tag1"])

    def test_save_adds_schema_version(self):
        draft = {"id": "draft_sv", "title": "SV"}
        saved = self.store.save_entity("personal", "drafts", draft)
        self.assertIn("schema_version", saved)

    def test_save_entity_returns_same_object(self):
        draft = {"id": "draft_ret", "title": "Return"}
        result = self.store.save_entity("personal", "drafts", draft)
        self.assertEqual(result["id"], "draft_ret")

    def test_get_entity_not_found_raises(self):
        with self.assertRaises(FileNotFoundError):
            self.store.get_entity("personal", "drafts", "nonexistent_id")

    def test_list_entities_empty(self):
        items = self.store.list_entities("personal", "chats")
        self.assertIsInstance(items, list)

    def test_list_entities_returns_all(self):
        for i in range(3):
            self.store.save_entity(
                "personal", "drafts",
                {"id": f"draft_x{i}", "title": f"D{i}", "updated_at": f"2024-01-0{i+1}T00:00:00+00:00"},
            )
        items = self.store.list_entities("personal", "drafts")
        self.assertEqual(len(items), 3)

    def test_list_entities_sorted_newest_first(self):
        self.store.save_entity(
            "personal", "drafts",
            {"id": "draft_old", "title": "Old", "updated_at": "2023-01-01T00:00:00+00:00"},
        )
        self.store.save_entity(
            "personal", "drafts",
            {"id": "draft_new", "title": "New", "updated_at": "2025-01-01T00:00:00+00:00"},
        )
        items = self.store.list_entities("personal", "drafts")
        self.assertEqual(items[0]["id"], "draft_new")

    def test_delete_entity_moves_to_archive(self):
        self.store.save_entity("personal", "drafts", {"id": "draft_del", "title": "Del"})
        self.store.delete_entity("personal", "drafts", "draft_del")
        self.assertFalse(
            (self.store.workspace_path("personal") / "drafts" / "draft_del.json").exists()
        )
        archive = self.store.root / "archive" / "drafts" / "personal"
        backups = list(archive.glob("draft_del_*.json"))
        self.assertEqual(len(backups), 1)

    def test_delete_nonexistent_entity_raises(self):
        with self.assertRaises(FileNotFoundError):
            self.store.delete_entity("personal", "drafts", "ghost_id1")

    def test_permanently_delete_entity(self):
        chat = {"id": "chat_perm", "title": "P", "messages": [], "archived": True}
        self.store.save_entity("personal", "chats", chat)
        self.store.permanently_delete_entity("personal", "chats", "chat_perm")
        self.assertFalse(
            (self.store.workspace_path("personal") / "chats" / "chat_perm.json").exists()
        )
        backup = self.store.root / "archive" / "deleted" / "chats" / "personal"
        backups = list(backup.glob("chat_perm_*.json"))
        self.assertEqual(len(backups), 1)

    def test_save_entity_enqueues_sync(self):
        self.store.save_entity("personal", "drafts", {"id": "draft_sync", "title": "S"})
        queue = self.store.read_json(self.store.root / "queue" / "pending_sync.json")
        ids = [item["payload"]["id"] for item in queue["items"]]
        self.assertIn("draft_sync", ids)

    def test_safe_id_used_in_get_entity(self):
        """get_entity dengan id berbahaya harus raise ValueError/FileNotFoundError."""
        with self.assertRaises((ValueError, FileNotFoundError)):
            self.store.get_entity("personal", "drafts", "../etc/passwd")


# ---------------------------------------------------------------------------
# JsonStore – Workspace management
# ---------------------------------------------------------------------------

class WorkspaceManagementTests(unittest.TestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.store = JsonStore(Path(self.tempdir.name))

    def tearDown(self):
        self.tempdir.cleanup()

    def test_create_workspace(self):
        ws = self.store.create_workspace("Marketing")
        self.assertEqual(ws["name"], "Marketing")
        self.assertIn(ws, self.store.list_workspaces())

    def test_create_workspace_generates_slug_id(self):
        ws = self.store.create_workspace("My Blog Content")
        self.assertRegex(ws["id"], r"^[a-z0-9-]+$")

    def test_create_workspace_initializes_brain(self):
        ws = self.store.create_workspace("Blog")
        brain = self.store.workspace_path(ws["id"]) / "brain"
        self.assertTrue((brain / "style_profile.json").exists())

    def test_create_workspace_duplicate_name_gets_unique_id(self):
        ws1 = self.store.create_workspace("Blog")
        ws2 = self.store.create_workspace("Blog")
        self.assertNotEqual(ws1["id"], ws2["id"])

    def test_create_workspace_empty_name_raises(self):
        with self.assertRaises(ValueError):
            self.store.create_workspace("")

    def test_create_workspace_name_too_long_raises(self):
        with self.assertRaises(ValueError):
            self.store.create_workspace("A" * 61)

    def test_rename_workspace(self):
        ws = self.store.create_workspace("OldName")
        updated = self.store.rename_workspace(ws["id"], "NewName")
        self.assertEqual(updated["name"], "NewName")
        names = [w["name"] for w in self.store.list_workspaces()]
        self.assertIn("NewName", names)
        self.assertNotIn("OldName", names)

    def test_rename_nonexistent_workspace_raises(self):
        with self.assertRaises(KeyError):
            self.store.rename_workspace("nonexistent_ws1", "X")

    def test_delete_workspace_removes_from_registry(self):
        ws = self.store.create_workspace("ToDelete")
        self.store.delete_workspace(ws["id"])
        ids = {w["id"] for w in self.store.list_workspaces()}
        self.assertNotIn(ws["id"], ids)

    def test_cannot_delete_default_workspace(self):
        with self.assertRaises(ValueError):
            self.store.delete_workspace("personal")

    def test_delete_nonexistent_workspace_raises(self):
        with self.assertRaises(KeyError):
            self.store.delete_workspace("nonexistent_ws2")

    def test_set_active_workspace(self):
        ws = self.store.create_workspace("Active")
        self.store.set_active_workspace(ws["id"])
        self.assertEqual(self.store.active_workspace(), ws["id"])

    def test_set_active_unknown_workspace_raises(self):
        with self.assertRaises(KeyError):
            self.store.set_active_workspace("unknown_ws3")

    def test_delete_active_workspace_resets_to_personal(self):
        ws = self.store.create_workspace("Temp")
        self.store.set_active_workspace(ws["id"])
        self.store.delete_workspace(ws["id"])
        self.assertEqual(self.store.active_workspace(), "personal")


# ---------------------------------------------------------------------------
# JsonStore – Snapshot
# ---------------------------------------------------------------------------

class SnapshotTests(unittest.TestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.store = JsonStore(Path(self.tempdir.name))

    def tearDown(self):
        self.tempdir.cleanup()

    def test_snapshot_creates_zip(self):
        entry = self.store.create_snapshot()
        zip_path = self.store.root / "snapshots" / entry["file"]
        self.assertTrue(zip_path.exists())
        self.assertTrue(zip_path.name.endswith(".zip"))

    def test_snapshot_recorded_in_manifest(self):
        entry = self.store.create_snapshot()
        manifest = self.store.read_json(self.store.root / "snapshots" / "manifest.json")
        ids = [item["id"] for item in manifest["items"]]
        self.assertIn(entry["id"], ids)

    def test_snapshot_path_resolves_correctly(self):
        entry = self.store.create_snapshot()
        path = self.store.snapshot_path(entry["id"])
        self.assertTrue(path.exists())

    def test_snapshot_path_unknown_raises(self):
        with self.assertRaises(FileNotFoundError):
            self.store.snapshot_path("snapshot_9999_99_99_999999")

    def test_multiple_snapshots_newest_first(self):
        import time
        e1 = self.store.create_snapshot()
        time.sleep(1)  # snapshot ID pakai granularitas detik
        e2 = self.store.create_snapshot()
        manifest = self.store.read_json(self.store.root / "snapshots" / "manifest.json")
        order = [item["id"] for item in manifest["items"]]
        # e2 dibuat lebih baru, harus muncul lebih dulu (index lebih kecil)
        self.assertLess(order.index(e2["id"]), order.index(e1["id"]))


# ---------------------------------------------------------------------------
# JsonStore – write_json
# ---------------------------------------------------------------------------

class WriteJsonTests(unittest.TestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.store = JsonStore(Path(self.tempdir.name))

    def tearDown(self):
        self.tempdir.cleanup()

    def test_write_and_read_round_trip(self):
        path = Path(self.tempdir.name) / "test.json"
        data = {"key": "value", "num": 42}
        self.store.write_json(path, data)
        result = self.store.read_json(path)
        self.assertEqual(result, data)

    def test_read_json_missing_with_default(self):
        path = Path(self.tempdir.name) / "missing.json"
        result = self.store.read_json(path, default={"empty": True})
        self.assertEqual(result, {"empty": True})

    def test_read_json_missing_no_default_raises(self):
        path = Path(self.tempdir.name) / "absent.json"
        with self.assertRaises(FileNotFoundError):
            self.store.read_json(path)

    def test_ensure_json_does_not_overwrite(self):
        path = Path(self.tempdir.name) / "ensure.json"
        self.store.write_json(path, {"v": 1})
        self.store.ensure_json(path, {"v": 99})
        result = self.store.read_json(path)
        self.assertEqual(result["v"], 1)

    def test_write_json_non_ascii_preserved(self):
        path = Path(self.tempdir.name) / "unicode.json"
        data = {"text": "Strategi soft selling produk dengan harga terjangkau"}
        self.store.write_json(path, data)
        result = self.store.read_json(path)
        self.assertEqual(result["text"], data["text"])


# ---------------------------------------------------------------------------
# JsonStore – Sync queue
# ---------------------------------------------------------------------------

class SyncQueueTests(unittest.TestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.store = JsonStore(Path(self.tempdir.name))

    def tearDown(self):
        self.tempdir.cleanup()

    def test_enqueue_sync_appends_item(self):
        self.store.enqueue_sync("drafts", "personal", {"id": "d1"})
        queue = self.store.read_json(self.store.root / "queue" / "pending_sync.json")
        self.assertEqual(len(queue["items"]), 1)
        self.assertEqual(queue["items"][0]["type"], "drafts")

    def test_enqueue_sync_capped_at_500(self):
        for i in range(505):
            self.store.enqueue_sync("x", "personal", {"id": f"i{i}"})
        queue = self.store.read_json(self.store.root / "queue" / "pending_sync.json")
        self.assertLessEqual(len(queue["items"]), 500)


# ---------------------------------------------------------------------------
# context.py – requested_workspaces
# ---------------------------------------------------------------------------

class RequestedWorkspacesTests(unittest.TestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.store = JsonStore(Path(self.tempdir.name))
        self._orig = context_module.store
        context_module.store = self.store

    def tearDown(self):
        context_module.store = self._orig
        self.tempdir.cleanup()

    def test_no_cross_workspace_term_returns_empty(self):
        self.store.create_workspace("Marketing")
        result = context_module.requested_workspaces("personal", "Apa isi draft affiliate?")
        self.assertEqual(result, [])

    def test_explicit_workspace_name_is_detected(self):
        ws = self.store.create_workspace("Marketing")
        result = context_module.requested_workspaces("personal", "Baca workspace Marketing")
        self.assertIn(ws["id"], result)

    def test_current_workspace_not_included_in_cross(self):
        result = context_module.requested_workspaces("personal", "Baca workspace personal")
        self.assertNotIn("personal", result)

    def test_case_insensitive_workspace_name(self):
        ws = self.store.create_workspace("BlogKu")
        result = context_module.requested_workspaces("personal", "cek workspace blogku")
        self.assertIn(ws["id"], result)

    def test_multiple_workspace_terms_detected(self):
        ws1 = self.store.create_workspace("Alpha")
        ws2 = self.store.create_workspace("Beta")
        result = context_module.requested_workspaces(
            "personal", "bandingkan workspace alpha dan beta"
        )
        self.assertIn(ws1["id"], result)
        self.assertIn(ws2["id"], result)


# ---------------------------------------------------------------------------
# context.py – build_chat_context
# ---------------------------------------------------------------------------

class BuildChatContextTests(unittest.TestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.store = JsonStore(Path(self.tempdir.name))
        self._orig = context_module.store
        context_module.store = self.store

    def tearDown(self):
        context_module.store = self._orig
        self.tempdir.cleanup()

    def test_context_contains_inventory_line(self):
        ctx, extras = context_module.build_chat_context("personal", "Halo")
        self.assertIn("Inventaris:", ctx)

    def test_context_includes_relevant_draft(self):
        self.store.save_entity(
            "personal", "drafts",
            {"id": "draft_aff", "title": "Affiliate", "content": "Strategi soft selling produk."},
        )
        ctx, extras = context_module.build_chat_context("personal", "Apa isi draft affiliate?")
        self.assertIn("Strategi soft selling", ctx)

    def test_extras_empty_when_no_cross_workspace(self):
        _, extras = context_module.build_chat_context("personal", "Halo apa kabar?")
        self.assertEqual(extras, [])

    def test_context_contains_app_map(self):
        ctx, _ = context_module.build_chat_context("personal", "Bantuan")
        self.assertIn("PETA APLIKASI GHOSTWAITER", ctx)

    def test_context_contains_access_note_when_no_extras(self):
        ctx, _ = context_module.build_chat_context("personal", "Test")
        self.assertIn("Jangan membaca atau menyimpulkan data workspace lain", ctx)

    def test_context_contains_access_note_with_extras(self):
        ws = self.store.create_workspace("Lain")
        ctx, _ = context_module.build_chat_context(
            "personal", f"Baca workspace {ws['name']}"
        )
        self.assertIn("pengguna menyebutnya secara eksplisit", ctx)

    def test_draft_content_truncated_in_context(self):
        long_content = "X" * 2000
        self.store.save_entity(
            "personal", "drafts",
            {"id": "draft_long1", "title": "LongDraft", "content": long_content},
        )
        ctx, _ = context_module.build_chat_context("personal", "longdraft")
        # Konteks tidak boleh membawa seluruh 2000 karakter X
        self.assertLess(ctx.count("X"), 2000)

    def test_archived_chats_excluded_from_inventory(self):
        self.store.save_entity(
            "personal", "chats",
            {
                "id": "chat_arch1",
                "title": "Old",
                "messages": [],
                "archived": True,
                "updated_at": "2024-01-01T00:00:00+00:00",
            },
        )
        ctx, _ = context_module.build_chat_context("personal", "berapa chat aktif?")
        self.assertIn("0 chat aktif", ctx)


# ---------------------------------------------------------------------------
# context.py – _truncate helper
# ---------------------------------------------------------------------------

class TruncateTests(unittest.TestCase):
    def test_short_string_not_truncated(self):
        from backend.context import _truncate
        self.assertEqual(_truncate("Hello", 100), "Hello")

    def test_long_string_truncated_with_ellipsis(self):
        from backend.context import _truncate
        result = _truncate("A" * 200, 50)
        self.assertTrue(result.endswith("…"))
        self.assertLessEqual(len(result), 50)

    def test_exact_limit_not_truncated(self):
        from backend.context import _truncate
        s = "A" * 50
        self.assertEqual(_truncate(s, 50), s)


if __name__ == "__main__":
    unittest.main(verbosity=2)
