---
title: Ghostwriter
emoji: ✍️
colorFrom: red
colorTo: pink
sdk: docker
app_port: 7860
fullWidth: true
pinned: false
short_description: AI writing coach with memory
models:
  - OpenRouter
  - Google Gemini
  - Groq
  - DeepSeek
  - Mistral
  - Kilo
tags:
  - writing
  - pwa
  - fastapi
  - inference-providers
---

# GhostWriter v1.0

GhostWriter adalah web app penulisan personal yang menggabungkan chat, editor tulisan, sistem pembelajaran gaya, dan sinkronisasi GitHub. Aplikasi ini berjalan sebagai satu halaman PWA dengan backend FastAPI yang menyimpan data secara lokal dan dapat dipadukan dengan Hugging Face Space.

> ⚠️ Pengingat sinkronisasi: repo GitHub ini terhubung ke Hugging Face Space dan sebaliknya. Perubahan yang dibuat di GitHub harus dipush ke repo yang sama, lalu Space perlu di-rebuild atau di-pull sesuai alur deployment; perubahan yang dibuat di Space juga perlu disinkronkan kembali ke GitHub agar data tetap konsisten.

## Ringkasan versi 1.0

- UI utama: Chat, Write, Brain, dan Settings.
- Provider AI dan model dipilih langsung dari UI sesuai kebutuhan perangkat pengguna.
- Tidak ada model bawaan yang dipaksa oleh server; pengguna mengisi API key provider yang ingin dipakai.
- Chat dan generate tulisan berjalan dengan streaming.
- Draft autosave dan word count tersedia di editor.
- Brain menyimpan style rules, thinking patterns, memory, rules, references, dan learning proposals.
- Workspace dapat dibuat, dipilih, di-rename, dan dihapus (kecuali workspace default `writing`).
- Data dapat diekspor/impor dalam format ZIP dan disinkronkan ke GitHub secara manual.
- Repo GitHub dan Hugging Face Space dapat dijaga agar tetap sinkron dua arah.

## Fitur utama

- Multi-provider inference dengan provider dan model yang dipilih langsung dari UI.
- Streaming chat dan writing generation.
- Safe Markdown rendering dengan filter otomatis untuk blok `<think>`.
- Draft editor dengan autosave lokal dan tombol train/copy.
- Brain Center untuk mengelola style, thinking, memory, rules, dan proposal.
- Referensi web via Tavily untuk mendukung pembelajaran.
- Snapshot, export ZIP, dan import ZIP.
- PWA dengan service worker dan install support.

## Konfigurasi environment

Untuk deployment (misalnya Hugging Face Space), atur secret/variable berikut. Pastikan juga repo GitHub dan Space yang dipakai sudah terkoneksi dengan benar agar sinkronisasi dua arah berjalan konsisten.

| Jenis | Nama | Wajib | Keterangan |
|---|---|---:|---|
| Secret | `HF_TOKEN` | Tidak | Token provider opsional untuk deployment server-side |
| Secret | `APP_PASSWORD` | Tidak | Password aplikasi jika ingin proteksi single-user |
| Secret | `SESSION_SECRET` | Tidak | Secret untuk session cookie |
| Secret | `GITHUB_TOKEN` | Tidak | Token GitHub untuk backup/sync |
| Secret | `TAVILY_API_KEY` | Tidak | API key untuk pencarian referensi web |
| Variable | `GITHUB_BACKUP_REPO` | Tidak | Format `owner/repo` |
| Variable | `SYNC_DEBOUNCE_SECONDS` | Tidak | Delay autosync, default `45` |
| Variable | `DATA_DIR` | Tidak | Lokasi storage data jika ingin menyimpan di path lain |

## Sync GitHub ↔ Hugging Face Space

- Push perubahan ke repo GitHub utama, lalu lakukan rebuild/redeploy di Hugging Face Space.
- Setelah Space berjalan, gunakan fitur sync di aplikasi untuk menarik data dari repo GitHub bila dibutuhkan.
- Hindari mengubah data di dua tempat secara terpisah tanpa sinkronisasi ulang.
- Untuk backup yang aman, simpan token dan repo target di secrets/variables Space sesuai konfigurasi di atas.

## Struktur data

Aplikasi menyimpan metadata di folder `data` (atau lokasi yang ditentukan oleh `DATA_DIR`). Struktur utama tetap mengikuti layout lokal-first yang sama:

```text
data/
  system/
    settings.json
    models.json
    workspaces.json
  workspaces/
    <workspace_id>/
      drafts/
      chats/
      brain/
      references/
      summary/
      learning/
      settings/
  queue/
  snapshots/
  archive/
```

## Menjalankan Server Lokal

Berikut panduan untuk mengaktifkan server GhostWriter di berbagai sistem operasi:

### Windows (PowerShell)
```powershell
python -m venv .venv
.venv\Scripts\Activate.ps1
pip install -r requirements.txt
copy .env.example .env
uvicorn app:app --reload --port 7860
```

### Ubuntu / Debian
```bash
sudo apt update
sudo apt install python3-venv python3-pip
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
uvicorn app:app --reload --port 7860
```

### Termux (Android)
Pastikan Anda sudah menginstal paket yang dibutuhkan sebelum menjalankan server.
```bash
pkg update && pkg upgrade
pkg install python binutils
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
uvicorn app:app --reload --port 7860
```

Jika Anda tidak menggunakan `.env`, export variabel yang diperlukan sebelum menjalankan server.

## Catatan arsitektur

- Backend: FastAPI, REST API, streaming response, auth cookie/session.
- Frontend: static HTML/CSS/JS, no heavy framework.
- Storage: JSON file per entity, bukan satu database tunggal.
- Sync: manual GitHub push/pull via GitHub API.
- PWA: service worker + Web App Manifest untuk install di mobile.

## Bukan fitur

Implementasi ini sengaja tidak menyediakan terminal agent, command execution, atau model lokal GGUF. File `base-project.sh` tetap ada sebagai referensi historis, tetapi aplikasi yang aktif saat ini berjalan dari backend dan frontend yang ada di repo ini.
