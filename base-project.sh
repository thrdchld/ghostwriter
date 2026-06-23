#!/bin/bash

bangun_arsitektur() {
    echo "Memeriksa dependensi sistem..."
    if ! dpkg -s git >/dev/null 2>&1; then pkg install git -y; fi
    
    # Install python-multipart untuk fitur Upload / Import File Model Lokal
    python -m pip show python-multipart >/dev/null 2>&1 || python -m pip install python-multipart

    mkdir -p backend frontend models WritingBrain/{lessons,style_profile,drafts,finals,backups,chats}

    cat << 'EOF_HTML' > frontend/index.html
<!DOCTYPE html>
<html lang="id">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
    <title>Ghost Waiter</title>
    <style>
        :root { 
            --bg: #0d1117; --surf: #161b22; --border: #30363d; 
            --prim: #8b5cf6; --prim-hover: #9d74f7; 
            --text: #c9d1d9; --text-strong: #ffffff; --text-muted: #8b949e; 
            --danger: #f85149; --success: #2ea043;
        }
        body { 
            margin: 0; background: var(--bg); color: var(--text); 
            font-family: -apple-system, system-ui, sans-serif; 
            display: flex; flex-direction: column; height: 100vh;
        }
        
        /* Sticky Model Status Bar */
        .status-bar {
            background: #010409; padding: 10px 16px; font-size: 0.85rem;
            display: flex; justify-content: space-between; align-items: center;
            border-bottom: 1px solid var(--border); font-weight: 500;
        }
        .status-badge { display: flex; align-items: center; gap: 6px; }
        .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--text-muted); }
        .dot.active { background: var(--success); box-shadow: 0 0 8px var(--success); }

        nav { display: flex; background: var(--surf); border-bottom: 1px solid var(--border); overflow-x: auto; white-space: nowrap; }
        .nav-btn { 
            flex: 1; background: none; border: none; color: var(--text-muted); 
            padding: 16px 12px; cursor: pointer; border-bottom: 2px solid transparent; 
            font-weight: 600; font-size: 0.95rem; transition: 0.2s;
        }
        .nav-btn.active { color: var(--text-strong); border-bottom: 2px solid var(--prim); }
        .nav-btn:hover:not(.active) { color: var(--text); }
        
        main { padding: 16px; overflow-y: auto; flex: 1; height: calc(100vh - env(safe-area-inset-bottom)); scroll-padding-bottom: 50vh; }
        .view { display: none; animation: fadeIn 0.2s ease; } .view.active { display: block; }
        @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }

        h2, h3, h4 { margin-top: 0; color: var(--text-strong); }
        textarea, select, input { 
            width: 100%; background: #010409; color: var(--text-strong); 
            border: 1px solid var(--border); padding: 14px; margin-bottom: 16px; 
            box-sizing: border-box; border-radius: 6px; font-family: inherit; font-size: 1rem;
            transition: 0.2s border;
        }
        textarea { min-height: 140px; resize: vertical; line-height: 1.5; }
        textarea:focus, input:focus, select:focus { outline: none; border-color: var(--prim); }
        
        button { 
            padding: 12px 16px; width: 100%; font-weight: 600; font-size: 1rem; 
            cursor: pointer; border-radius: 6px; margin-bottom: 10px; border: 1px solid transparent; 
            transition: 0.2s; display: flex; justify-content: center; align-items: center; gap: 8px;
        }
        .prim { background: var(--prim); color: #ffffff; }
        .prim:hover { background: var(--prim-hover); }
        .secondary { background: var(--surf); color: var(--text-strong); border-color: var(--border); }
        .secondary:hover { background: #21262d; }
        .danger { background: rgba(248, 81, 73, 0.1); color: var(--danger); border-color: rgba(248, 81, 73, 0.4); }
        .success { background: rgba(46, 160, 67, 0.1); color: var(--success); border-color: rgba(46, 160, 67, 0.4); }
        button:disabled { opacity: 0.6; cursor: not-allowed; }
        
        .card { background: var(--surf); padding: 20px; border-radius: 8px; margin-bottom: 16px; border: 1px solid var(--border); }
        
        .sub-nav { display: flex; background: #010409; padding: 4px; border-radius: 6px; margin-bottom: 16px; border: 1px solid var(--border); }
        .sub-btn { flex: 1; background: none; border: none; color: var(--text-muted); padding: 8px; cursor: pointer; border-radius: 4px; font-size: 0.9rem; font-weight: 500;}
        .sub-btn.active { background: var(--surf); color: var(--text-strong); border: 1px solid var(--border); }
        
        .m-item { display: flex; justify-content: space-between; padding: 14px 0; border-bottom: 1px solid var(--border); align-items: center; }
        .m-item:last-child { border-bottom: none; }
        
        .draft-list { max-height: 200px; overflow-y: auto; background: #010409; border-radius: 6px; border: 1px solid var(--border); margin-bottom: 16px; }
        .draft-item { padding: 14px; border-bottom: 1px solid var(--border); cursor: pointer; font-size: 0.95rem; }
        .draft-item:hover { background: var(--surf); }
        .draft-item:last-child { border-bottom: none; }

        /* Accordion Style */
        .accordion-item { border: 1px solid var(--border); border-radius: 8px; margin-bottom: 12px; background: var(--surf); overflow: hidden; }
        .accordion-header { 
            width: 100%; text-align: left; padding: 16px 20px; background: var(--surf); 
            color: var(--text-strong); border: none; font-weight: 600; font-size: 1.05rem; 
            cursor: pointer; display: flex; justify-content: space-between; align-items: center; 
            margin-bottom: 0; border-radius: 0; transition: background 0.2s;
        }
        .accordion-header:hover { background: #21262d; }
        .accordion-header::after { content: '▼'; font-size: 0.8rem; transition: transform 0.3s; color: var(--text-muted); }
        .accordion-header.active::after { transform: rotate(180deg); color: var(--prim); }
        .accordion-header.active { border-bottom: 1px solid var(--border); }
        .accordion-content { padding: 20px; display: none; background: var(--surf); }

        #toast-box { position: fixed; bottom: 20px; right: 20px; left: 20px; z-index: 1000; display: flex; flex-direction: column; gap: 8px; pointer-events: none; }
        .toast { background: var(--surf); color: var(--text-strong); border: 1px solid var(--border); border-left: 4px solid var(--prim); padding: 14px 16px; border-radius: 6px; font-size: 0.95rem; box-shadow: 0 8px 24px rgba(0,0,0,0.5); animation: slideIn 0.3s ease forwards, fadeOut 0.3s ease 2.7s forwards; }
        .toast.error { border-left-color: var(--danger); }
        .toast.success { border-left-color: var(--success); }
        @keyframes slideIn { from { transform: translateY(20px); opacity: 0; } to { transform: translateY(0); opacity: 1; } }
        @keyframes fadeOut { to { opacity: 0; } }

        /* Progress Bar Style */
        .progress-container { background: #010409; border: 1px solid var(--border); border-radius: 6px; height: 20px; position: relative; margin-bottom: 16px; overflow: hidden; display: none; }
        .progress-bar { background: var(--prim); height: 100%; width: 0%; transition: width 0.1s ease; }
        .progress-text { position: absolute; width: 100%; text-align: center; top: 0; left: 0; font-size: 0.8rem; line-height: 20px; color: var(--text-strong); font-weight: bold; }

        /* Loading Overlay */
        #loading-overlay { position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.8); z-index: 2000; display: none; flex-direction: column; justify-content: center; align-items: center; color: white; }
        .spinner { border: 4px solid rgba(255,255,255,0.3); border-top: 4px solid var(--prim); border-radius: 50%; width: 40px; height: 40px; animation: spin 1s linear infinite; margin-bottom: 16px; }
        @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }

        /* Chat Styles */
        .chat-layout { display: flex; flex-direction: column; height: calc(100vh - 180px); }
        .chat-header { display: flex; justify-content: space-between; margin-bottom: 8px; }
        .chat-history { flex: 1; overflow-y: auto; background: #010409; border: 1px solid var(--border); border-radius: 6px; padding: 10px; margin-bottom: 10px; display: flex; flex-direction: column; gap: 8px; }
        .chat-msg { max-width: 85%; padding: 10px 14px; border-radius: 8px; font-size: 0.95rem; line-height: 1.4; word-wrap: break-word; }
        .chat-msg.user { align-self: flex-end; background: var(--prim); color: white; border-bottom-right-radius: 0; }
        .chat-msg.ai { align-self: flex-start; background: var(--surf); border: 1px solid var(--border); border-bottom-left-radius: 0; }
        .chat-input-area { display: flex; gap: 8px; }
        .chat-input-area textarea { min-height: 50px; margin-bottom: 0; flex: 1; resize: none; }
        .chat-input-area button { width: auto; margin-bottom: 0; padding: 0 20px; }
        
        .chat-session-list { max-height: 150px; overflow-y: auto; margin-bottom: 10px; background: #010409; border-radius: 6px; border: 1px solid var(--border); display: none; }
        .chat-session-item { padding: 10px; border-bottom: 1px solid var(--border); cursor: pointer; font-size: 0.9rem; }
        .chat-session-item:hover { background: var(--surf); }
    </style>
</head>
<body>
    <div class="status-bar">
        <div class="status-badge">
            <div class="dot" id="status-dot"></div>
            <span id="status-text">Model Tidak Aktif</span>
        </div>
        <div style="color: var(--text-muted); font-size: 0.8rem;" id="status-meta">Rules: 0</div>
    </div>

    <nav>
        <button class="nav-btn active" onclick="nav('chat')">💬 Ngobrol</button>
        <button class="nav-btn" onclick="nav('write')">✍️ Tulis</button>
        <button class="nav-btn" onclick="nav('train')">🧠 Latih</button>
        <button class="nav-btn" onclick="nav('settings')">⚙️ Pengaturan</button>
    </nav>
    <main>
        <!-- VIEW: TULIS -->
        <div id="v-write" class="view">
            <h2>Ruang Menulis</h2>
            <div class="card" style="padding: 14px;">
                <h3 style="margin-top:0; font-size: 1rem; cursor: pointer; color: var(--text-muted); margin-bottom: 0;" onclick="toggleDrafts()">📚 Lihat Draf Tersimpan</h3>
                <div id="draft-list-container" style="display:none; margin-top: 12px; border-top: 1px solid var(--border); padding-top: 12px;">
                    <div class="draft-list" id="draft-list">Memuat...</div>
                </div>
            </div>
            
            <textarea id="write-prompt" placeholder="Apa yang ingin Anda tulis hari ini?"></textarea>
            <button class="prim" id="btn-generate" onclick="generateDraft()">🚀 Minta AI Menulis</button>

            <div id="write-output-container" style="display: none; margin-top: 24px;">
                <input type="text" id="draft-title" placeholder="Beri judul tulisan ini...">
                <textarea id="write-result" style="min-height: 300px;"></textarea>
                <button class="success" onclick="saveDraft()">💾 Simpan Draf</button>
                <button class="secondary" onclick="sendToTrain()">🎓 Jadikan Pelajaran</button>
            </div>
        </div>

        <!-- VIEW: LATIH -->
        <div id="v-train" class="view">
            <h2>Otak AI</h2>
            <div class="sub-nav">
                <button class="sub-btn active" onclick="sub('c')" id="b-c">Bandingkan Revisi</button>
                <button class="sub-btn" onclick="sub('o')" id="b-o">Analisis Pola</button>
            </div>
            <div id="t-c">
                <textarea id="draft-text" placeholder="Draf mentah dari AI..."></textarea>
                <textarea id="revised-text" placeholder="Hasil editan tulisan Anda..."></textarea>
                <button class="prim" id="btn-ext-c" onclick="analyzeText('c')">⚙️ Ekstrak Aturan</button>
            </div>
            <div id="t-o" style="display:none;">
                <textarea id="original-text" placeholder="Tempelkan contoh tulisan Anda di sini..."></textarea>
                <button class="prim" id="btn-ext-o" onclick="analyzeText('o')">⚙️ Ekstrak Aturan</button>
            </div>
            <div id="ai-result" style="display:none; margin-top:20px;">
                <h4 style="color:var(--prim); margin-bottom: 8px;">Kesimpulan AI (Edit bila perlu):</h4>
                <textarea id="rule-text" style="min-height: 80px;"></textarea>
                <button class="success" onclick="saveRule()">Simpan ke Memori</button>
                <button class="danger" onclick="discardRule()">Buang</button>
            </div>
        </div>
        
        <!-- VIEW: PENGATURAN DENGAN ACCORDION -->
        <div id="v-settings" class="view">
            <h2>Pengaturan Sistem</h2>
            
            <div class="accordion">
                <!-- MENU 1: MANAJEMEN MODEL -->
                <div class="accordion-item">
                    <button class="accordion-header active" onclick="toggleAcc(this)">🤖 Manajemen Model & Perangkat</button>
                    <div class="accordion-content" style="display: block;">
                        <label style="font-size:0.85rem; color:var(--text-muted); display:block; margin-bottom:8px;">Profil Perangkat (Alokasi RAM):</label>
                        <select id="device-profile">
                            <option value="sd660">Snapdragon 660 (4GB)</option>
                            <option value="dim700">Dimensity 700 (6GB)</option>
                        </select>
                        
                        <div style="display:flex; justify-content:space-between; align-items:center; margin-top:16px; margin-bottom:8px;">
                            <h4 style="margin:0;">Daftar Model</h4>
                            <button class="secondary" onclick="loadM()" style="width:auto; padding:4px 10px; margin:0; font-size:0.85rem;">Refresh</button>
                        </div>
                        <div id="m-list" style="background:#010409; border:1px solid var(--border); border-radius:6px; padding:0 12px; margin-bottom:16px;">Memindai...</div>
                        <button class="danger" onclick="unl()" style="margin-bottom:24px;">Kosongkan RAM</button>

                        <h4 style="border-top:1px solid var(--border); padding-top:16px; margin-bottom:8px;">📥 Unduh Model via URL</h4>
                        <input type="text" id="dl-url" placeholder="Tempelkan URL .gguf dari Hugging Face">
                        
                        <div id="dl-progress-container" class="progress-container">
                            <div id="dl-progress-bar" class="progress-bar"></div>
                            <div id="dl-progress-text" class="progress-text">0%</div>
                        </div>
                        <button class="prim" id="btn-download" onclick="startDownload()">Mulai Unduh</button>

                        <!-- FITUR BARU: IMPORT MODEL LOKAL -->
                        <h4 style="border-top:1px solid var(--border); padding-top:16px; margin-bottom:8px;">📁 Import Model dari File Manager</h4>
                        <p style="font-size:0.85rem; color:var(--text-muted); margin-top:0;">Pilih file .gguf dari penyimpanan internal HP Anda.</p>
                        <button class="secondary" onclick="document.getElementById('upload-model-file').click()">Pilih File .gguf</button>
                        <input type="file" id="upload-model-file" accept=".gguf" style="display:none" onchange="uploadModelLocal(this)">

                    </div>
                </div>

                <!-- MENU 2: BACKUP LOKAL -->
                <div class="accordion-item">
                    <button class="accordion-header" onclick="toggleAcc(this)">📦 Backup Lokal Offline</button>
                    <div class="accordion-content">
                        <p style="font-size:0.9rem; color:var(--text-muted); margin-top:0;">Cadangkan seluruh draf dan memori AI Anda ke dalam file ZIP.</p>
                        <button class="secondary" onclick="exportBrain()">Unduh Data (.zip)</button>
                        <button class="secondary" onclick="document.getElementById('import-file').click()">Restore Data (.zip)</button>
                        <input type="file" id="import-file" style="display:none" accept=".zip" onchange="importLocal(this)">
                    </div>
                </div>
                
                <!-- MENU 3: GITHUB SYNC -->
                <div class="accordion-item">
                    <button class="accordion-header" onclick="toggleAcc(this)">☁️ Cloud Sync (GitHub)</button>
                    <div class="accordion-content">
                        <p style="font-size:0.9rem; color:var(--text-muted); margin-top:0;">Hubungkan ke Private Repository untuk keamanan data ganda.</p>
                        <input type="text" id="gh-user" placeholder="Username GitHub">
                        <input type="text" id="gh-repo" placeholder="Nama Repository">
                        <input type="password" id="gh-token" placeholder="Personal Access Token">
                        <button class="success" onclick="saveGitConfig()">Simpan Kredensial</button>
                        <div style="display:flex; gap:12px; margin-top:8px;">
                            <button class="prim" id="btn-gh-push" onclick="pushToGitHub()">Push</button>
                            <button class="danger" id="btn-gh-pull" onclick="pullFromGitHub()">Pull</button>
                        </div>
                    </div>
                </div>

            </div> <!-- End of Accordion -->
        </div>
        <!-- VIEW: CHAT -->
        <div id="v-chat" class="view active">
            <div class="chat-header">
                <h2>Obrolan</h2>
                <button class="secondary" style="width: auto; padding: 6px 12px; margin: 0; font-size: 0.85rem;" onclick="toggleChatSessions()">📚 Riwayat</button>
            </div>
            
            <div id="chat-session-list" class="chat-session-list">Memuat...</div>
            
            <div class="chat-layout">
                <div class="chat-history" id="chat-history">
                    <div style="text-align:center; color:var(--text-muted); font-size:0.85rem; margin-top:20px;">Mulai obrolan baru. AI akan mempelajari gayamu!</div>
                </div>
                <div class="chat-input-area">
                    <textarea id="chat-input" placeholder="Ketik pesan..."></textarea>
                    <button class="prim" id="btn-chat-send" onclick="sendChat()">Kirim</button>
                </div>
                <button class="secondary" style="margin-top: 10px; padding: 8px;" onclick="newChat()">➕ Obrolan Baru</button>
            </div>
        </div>

    </main>

    <div id="loading-overlay">
        <div class="spinner"></div>
        <div id="loading-text">Memuat Model...</div>
    </div>
    <div id="toast-box"></div>

    <script>
        let currentRuleData = {};
        let lastAiDraft = "";
        let isDraftsLoaded = false;
        let isModelLoaded = false;
        let dlInterval = null;
        let currentChatId = null;

        window.onload = () => {
            loadM();
            updateStatusBar();
        };

        function showToast(msg, type='default') {
            const box = document.getElementById('toast-box');
            const t = document.createElement('div');
            t.className = `toast ${type}`;
            t.innerText = msg;
            box.appendChild(t);
            setTimeout(() => t.remove(), 3000);
        }

        // --- FUNGSI ACCORDION ---
        function toggleAcc(btn) {
            const content = btn.nextElementSibling;
            const isActive = btn.classList.contains('active');
            
            document.querySelectorAll('.accordion-header').forEach(h => {
                h.classList.remove('active');
                h.nextElementSibling.style.display = 'none';
            });
            
            if (!isActive) {
                btn.classList.add('active');
                content.style.display = 'block';
            }
        }

        function nav(v) { 
            document.querySelectorAll('.nav-btn, .view').forEach(e => e.classList.remove('active')); 
            event.target.classList.add('active'); 
            document.getElementById('v-'+v).classList.add('active'); 
            if(v==='settings') { loadM(); loadGitConfig(); } 
        }
        function sub(m) { 
            document.querySelectorAll('.sub-btn').forEach(e=>e.classList.remove('active')); 
            event.target.classList.add('active'); 
            document.getElementById('t-c').style.display=m==='c'?'block':'none'; 
            document.getElementById('t-o').style.display=m==='o'?'block':'none'; 
            document.getElementById('ai-result').style.display='none'; 
        }

        async function updateStatusBar() {
            try {
                const res = await (await fetch('/api/models/status')).json();
                const dot = document.getElementById('status-dot');
                const txt = document.getElementById('status-text');
                const meta = document.getElementById('status-meta');
                if(res.active_model) {
                    dot.className = "dot active";
                    txt.innerText = res.active_model.replace('.gguf','').toUpperCase();
                    meta.innerText = `Rules: ${res.rules_count}`;
                    isModelLoaded = true;
                    document.getElementById('device-profile').disabled = true;
                } else {
                    dot.className = "dot";
                    txt.innerText = "Model Tidak Aktif";
                    meta.innerText = `Rules: ${res.rules_count}`;
                    isModelLoaded = false;
                    document.getElementById('device-profile').disabled = false;
                }
            } catch(e){}
        }
        
        async function loadM() {
            const l = document.getElementById('m-list'); l.innerHTML = '<div style="padding:12px; color:var(--text-muted);">Memindai...</div>';
            try {
                const res = await (await fetch('/api/models')).json();
                if(!res.models.length) return l.innerHTML = '<div style="padding:12px; color:var(--text-muted);">Folder kosong.</div>';
                isModelLoaded = res.models.some(m => m.status === 'active');
                l.innerHTML = res.models.map(m => `
                    <div class="m-item" style="flex-direction:column; align-items:flex-start; gap:8px;">
                        <div><strong style="color:var(--text-strong);">${m.filename}</strong><br>
                        <small style="color:var(--text-muted);">${m.size_mb} MB ${m.status==='active'?' <span style="color:var(--success)">• Aktif</span>':''}</small></div>
                        <div style="display:flex; gap:8px; width:100%;">
                            <button class="secondary" style="width:auto; flex:1; padding:6px 12px; margin:0; font-size:0.9rem;" onclick="ld('${m.filename}')" ${m.status==='active'?'disabled':''}>Muat</button>
                            <button class="danger" style="width:auto; flex:1; padding:6px 12px; margin:0; font-size:0.9rem;" onclick="deleteModel('${m.filename}')" ${m.status==='active'?'disabled':''}>Hapus</button>
                        </div>
                    </div>`).join('');
                updateStatusBar();
            } catch(e) { l.innerHTML = '<div style="padding:12px; color:var(--danger);">Error koneksi.</div>'; }
        }

        async function ld(f) { 
            document.getElementById('loading-overlay').style.display = 'flex';
            showToast("Sedang memuat model ke RAM...");
            await fetch('/api/models/load', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({filename: f, device_profile: document.getElementById('device-profile').value}) }); 
            loadM(); 
            document.getElementById('loading-overlay').style.display = 'none';
            showToast("Model berhasil dimuat!", "success"); updateStatusBar();
        }

        async function unl() { await fetch('/api/models/unload', {method:'POST'}); loadM(); showToast("RAM dibersihkan."); updateStatusBar();}

        // FITUR BARU: Hapus Model
        async function deleteModel(f) {
            if(!confirm(`Hapus permanen model ${f} dari penyimpanan?`)) return;
            try {
                const res = await (await fetch('/api/models/delete', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({ filename: f }) })).json();
                if(res.status === 'success') { showToast("Model dihapus.", "success"); loadM(); } 
                else { showToast(res.message, "error"); }
            } catch(e) { showToast("Error menghapus model.", "error"); }
        }

        // FITUR BARU: Import Model Lokal via File Manager
        async function uploadModelLocal(el) {
            const file = el.files[0];
            if(!file) return;
            if(!file.name.endsWith('.gguf')) { showToast("Harus format file .gguf", "error"); el.value = ""; return; }

            const formData = new FormData();
            formData.append("file", file);

            showToast("⏳ Sedang mengunggah model... mohon tunggu.", "default");
            
            try {
                const res = await fetch('/api/models/upload', { method: 'POST', body: formData });
                const data = await res.json();
                if(data.status === 'success') { showToast("Model berhasil diunggah!", "success"); loadM(); } 
                else { showToast("Gagal: " + data.message, "error"); }
            } catch(e) { showToast("Gagal mengunggah file.", "error"); }
            el.value = "";
        }

        async function startDownload() {
            const url = document.getElementById('dl-url').value.trim();
            if(!url) return showToast("Masukkan URL terlebih dahulu!", "error");

            const btn = document.getElementById('btn-download');
            const progressContainer = document.getElementById('dl-progress-container');
            const progressBar = document.getElementById('dl-progress-bar');
            const progressText = document.getElementById('dl-progress-text');

            btn.disabled = true;
            btn.innerText = "⏳ Memulai Unduhan...";
            progressContainer.style.display = 'block';
            progressBar.style.width = '0%';
            progressText.innerText = '0%';

            try {
                const res = await fetch('/api/models/download', {
                    method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({ url: url })
                });
                const data = await res.json();
                
                if(data.status === 'started' || data.status === 'running') {
                    showToast("Proses unduhan berjalan.");
                    dlInterval = setInterval(async () => {
                        const pRes = await fetch('/api/models/download/progress');
                        const pData = await pRes.json();
                        
                        progressBar.style.width = pData.progress + '%';
                        progressText.innerText = pData.progress + '% (' + pData.status + ')';

                        if(pData.status === 'completed') {
                            clearInterval(dlInterval);
                            showToast("Model Berhasil Diunduh!", "success");
                            btn.disabled = false; btn.innerText = "Mulai Unduh";
                            document.getElementById('dl-url').value = '';
                            progressContainer.style.display = 'none';
                            loadM();
                        } else if(pData.status === 'failed' || pData.status === 'idle') {
                            clearInterval(dlInterval);
                            showToast("Unduhan gagal atau terputus.", "error");
                            btn.disabled = false; btn.innerText = "Mulai Unduh";
                        }
                    }, 1000);
                } else {
                    showToast(data.message || "Gagal mengunduh.", "error");
                    btn.disabled = false; btn.innerText = "Mulai Unduh";
                }
            } catch(e) {
                showToast("Terjadi kesalahan koneksi.", "error");
                btn.disabled = false; btn.innerText = "Mulai Unduh";
            }
        }

        let activeControllers = {};
        function cancelRequest(id) {
            if(activeControllers[id]) { activeControllers[id].abort(); delete activeControllers[id]; }
        }

        async function analyzeText(mode) {
            if(!isModelLoaded) return showToast("⚠️ Muat Model AI di Pengaturan terlebih dahulu!", "error");
            const btn = document.getElementById(mode === 'c' ? 'btn-ext-c' : 'btn-ext-o');
            const ctrlId = 'train_' + mode;
            if(btn.innerText === "Batalkan") { cancelRequest(ctrlId); return; }

            const source = mode === 'c' ? document.getElementById('draft-text').value : "";
            const final = mode === 'c' ? document.getElementById('revised-text').value : document.getElementById('original-text').value;
            if(!final) return showToast("Teks tidak boleh kosong!", "error");
            
            activeControllers[ctrlId] = new AbortController();
            btn.innerText = "Batalkan"; btn.classList.add('danger');

            try {
                const res = await fetch('/api/train/analyze', { 
                    signal: activeControllers[ctrlId].signal,
                    method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({ mode: mode, source_text: source, final_text: final }) 
                });
                const data = await res.json();
                if(data.status === 'success') {
                    currentRuleData = { mode: mode, source_text: source, final_text: final, rule: data.rule };
                    document.getElementById('rule-text').value = data.rule;
                    document.getElementById('ai-result').style.display = 'block';
                    showToast("Analisis selesai!", "success");
                }
            } catch(e) { 
                if(e.name === 'AbortError') showToast("Analisis dibatalkan.");
                else showToast("Gagal menganalisis.", "error"); 
            } finally {
                btn.classList.remove('danger');
                btn.innerText = "⚙️ Ekstrak Aturan";
                delete activeControllers[ctrlId];
            }
        }

        async function saveRule() {
            const rule = document.getElementById('rule-text').value.trim();
            if(!rule) return;
            currentRuleData.rule = rule;
            await fetch('/api/train/save', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(currentRuleData) });
            discardRule(); document.getElementById('draft-text').value = ''; document.getElementById('revised-text').value = ''; document.getElementById('original-text').value = '';
            showToast("Aturan disimpan ke memori!", "success"); updateStatusBar();
        }
        function discardRule() { currentRuleData = {}; document.getElementById('ai-result').style.display = 'none'; }

        function toggleDrafts() {
            const c = document.getElementById('draft-list-container');
            c.style.display = c.style.display === 'none' ? 'block' : 'none';
            if(c.style.display === 'block' && !isDraftsLoaded) fetchDrafts();
        }
        
        async function fetchDrafts() {
            const list = document.getElementById('draft-list');
            try {
                const res = await (await fetch('/api/drafts')).json();
                if(!res.drafts.length) return list.innerHTML = '<div class="draft-item" style="color:var(--text-muted)">Kosong</div>';
                
                // Menambahkan Tombol Hapus Draf
                list.innerHTML = res.drafts.map(d => `
                    <div class="draft-item" style="display:flex; justify-content:space-between; align-items:center;">
                        <div onclick="loadDraft('${d}')" style="flex:1; cursor:pointer;">📄 ${d.replace('.txt','')}</div>
                        <button class="danger" style="width:auto; padding:6px 10px; margin:0; font-size:0.8rem;" onclick="deleteDraft(event, '${d}')">Hapus</button>
                    </div>
                `).join('');
                isDraftsLoaded = true;
            } catch(e) { list.innerHTML = 'Error'; }
        }

        // FITUR BARU: Hapus Draf
        async function deleteDraft(e, f) {
            e.stopPropagation(); // Mencegah loadDraft terpanggil
            if(!confirm(`Hapus draf ${f.replace('.txt','')} secara permanen?`)) return;
            try {
                await fetch('/api/drafts/delete', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({ filename: f }) });
                showToast("Draf dihapus.", "success");
                fetchDrafts();
            } catch(e) { showToast("Gagal menghapus draf.", "error"); }
        }

        async function loadDraft(f) {
            const res = await fetch(`/api/drafts/load?filename=${encodeURIComponent(f)}`);
            const data = await res.json();
            document.getElementById('draft-title').value = f.replace('.txt', '');
            document.getElementById('write-result').value = data.content;
            lastAiDraft = data.content;
            document.getElementById('write-output-container').style.display = 'block';
        }

        async function generateDraft() {
            if(!isModelLoaded) return showToast("⚠️ Muat Model AI di Pengaturan terlebih dahulu!", "error");
            const btn = document.getElementById('btn-generate');
            if(btn.innerText === "Batalkan") { cancelRequest('write'); return; }

            const prompt = document.getElementById('write-prompt').value.trim();
            if(!prompt) return showToast("Topik tidak boleh kosong!", "error");
            
            activeControllers['write'] = new AbortController();
            btn.innerText = "Batalkan"; btn.classList.add('danger');
            
            const outContainer = document.getElementById('write-output-container');
            const outText = document.getElementById('write-result');
            const titleInput = document.getElementById('draft-title');
            
            outContainer.style.display = 'block';
            outText.value = '';
            titleInput.value = "Draf_" + new Date().getTime();

            try {
                const res = await fetch('/api/write/generate', { 
                    signal: activeControllers['write'].signal,
                    method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({ prompt: prompt }) 
                });
                const reader = res.body.getReader();
                const decoder = new TextDecoder("utf-8");

                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    outText.value += decoder.decode(value, { stream: true });
                    outText.scrollTop = outText.scrollHeight; 
                }
                lastAiDraft = outText.value;
                showToast("Draf selesai dibuat!", "success");
            } catch(e) { 
                if(e.name === 'AbortError') showToast("Penulisan dibatalkan.");
                else { outText.value = "Error koneksi AI."; showToast("Koneksi terputus.", "error"); }
            } finally {
                btn.classList.remove('danger');
                btn.innerText = "🚀 Minta AI Menulis";
                delete activeControllers['write'];
            }
        }

        async function saveDraft() {
            const title = document.getElementById('draft-title').value.trim() || "Draf";
            const content = document.getElementById('write-result').value;
            await fetch('/api/drafts/save', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({ filename: title + ".txt", content: content }) });
            isDraftsLoaded = false; showToast("Draf tersimpan!", "success");
        }
        function sendToTrain() {
            const edited = document.getElementById('write-result').value;
            nav('train'); sub('c');
            document.getElementById('draft-text').value = lastAiDraft;
            document.getElementById('revised-text').value = edited;
            showToast("Dikirim ke Latih AI.");
        }

        // --- FUNGSI NGOBROL (CHAT) ---
        function toggleChatSessions() {
            const list = document.getElementById('chat-session-list');
            list.style.display = list.style.display === 'none' ? 'block' : 'none';
            if (list.style.display === 'block') loadChatSessions();
        }

        async function loadChatSessions() {
            const list = document.getElementById('chat-session-list');
            try {
                const res = await (await fetch('/api/chat/sessions')).json();
                if (!res.sessions.length) return list.innerHTML = '<div class="chat-session-item" style="color:var(--text-muted)">Belum ada obrolan.</div>';
                list.innerHTML = res.sessions.map(s => `
                    <div class="chat-session-item" style="display:flex; justify-content:space-between; align-items:center; gap:10px;">
                        <span onclick="loadChat('${s.id}')" style="cursor:pointer; flex:1; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">💬 ${s.title || s.id}</span>
                        <div style="display:flex; gap:5px; flex-shrink:0;">
                            <button class="secondary" style="padding:4px 8px; font-size:0.75rem; margin:0; min-width:30px;" onclick="renameChat('${s.id}', '${(s.title || s.id).replace(/'/g, "\\'")}')">✏️</button>
                            <button class="danger" style="padding:4px 8px; font-size:0.75rem; margin:0; min-width:30px;" onclick="deleteChat('${s.id}')">🗑️</button>
                        </div>
                    </div>
                `).join('');
            } catch(e) { list.innerHTML = 'Error memuat sesi.'; }
        }

        async function renameChat(id, oldTitle) {
            const newTitle = prompt("Masukkan nama baru untuk obrolan ini:", oldTitle);
            if(newTitle && newTitle.trim() !== "") {
                await fetch('/api/chat/rename', {
                    method: 'POST', headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({ chat_id: id, new_title: newTitle.trim() })
                });
                loadChatSessions();
            }
        }

        async function deleteChat(id) {
            if(confirm("Hapus obrolan ini secara permanen?")) {
                await fetch('/api/chat/delete', {
                    method: 'POST', headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({ chat_id: id })
                });
                if(currentChatId === id) newChat();
                loadChatSessions();
            }
        }

        async function newChat() {
            currentChatId = null;
            document.getElementById('chat-history').innerHTML = '<div style="text-align:center; color:var(--text-muted); font-size:0.85rem; margin-top:20px;">Mulai obrolan baru. AI akan mempelajari gayamu!</div>';
            document.getElementById('chat-session-list').style.display = 'none';
        }

        async function loadChat(id) {
            currentChatId = id;
            document.getElementById('chat-session-list').style.display = 'none';
            const hist = document.getElementById('chat-history');
            hist.innerHTML = '<div style="text-align:center; color:var(--text-muted); font-size:0.85rem;">Memuat...</div>';
            try {
                const res = await (await fetch(`/api/chat/session/${id}`)).json();
                hist.innerHTML = '';
                res.messages.forEach(m => {
                    if(m.role === 'system') return;
                    const div = document.createElement('div');
                    div.className = "chat-msg " + m.role;
                    div.innerText = m.content;
                    hist.appendChild(div);
                });
                hist.scrollTop = hist.scrollHeight;
            } catch(e) { hist.innerHTML = 'Error memuat obrolan.'; }
        }

        async function sendChat() {
            if(!isModelLoaded) return showToast("⚠️ Muat Model AI di Pengaturan terlebih dahulu!", "error");
            const btn = document.getElementById('btn-chat-send');
            if(btn.innerText === "Batalkan") { cancelRequest('chat'); return; }

            const input = document.getElementById('chat-input');
            const msg = input.value.trim();
            if(!msg) return;

            const hist = document.getElementById('chat-history');
            if (hist.innerHTML.includes('Mulai obrolan baru')) hist.innerHTML = '';
            
            const userDiv = document.createElement('div');
            userDiv.className = 'chat-msg user';
            userDiv.innerText = msg;
            hist.appendChild(userDiv);
            hist.scrollTop = hist.scrollHeight;
            input.value = '';

            activeControllers['chat'] = new AbortController();
            btn.innerText = 'Batalkan'; btn.classList.add('danger');

            const aiDiv = document.createElement('div');
            aiDiv.className = 'chat-msg ai';
            aiDiv.innerText = 'Mikir...';
            hist.appendChild(aiDiv);
            hist.scrollTop = hist.scrollHeight;

            try {
                const res = await fetch('/api/chat/generate', {
                    signal: activeControllers['chat'].signal,
                    method: 'POST', headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({ chat_id: currentChatId || "", message: msg })
                });

                if(res.headers.get('content-type') && res.headers.get('content-type').includes('application/json')) {
                    const data = await res.json();
                    if(data.status === 'error') { aiDiv.innerText = data.message || "Error"; }
                    else if(data.detail) { aiDiv.innerText = "Error: " + (typeof data.detail === 'string' ? data.detail : JSON.stringify(data.detail)); }
                    else { aiDiv.innerText = "Error server."; }
                } else {
                    aiDiv.innerText = '';
                    const reader = res.body.getReader();
                    const decoder = new TextDecoder("utf-8");
                    while (true) {
                        const { done, value } = await reader.read();
                        if (done) break;
                        const chunk = decoder.decode(value, { stream: true });
                        let textToPrint = chunk;
                        if(textToPrint.includes("CHAT_ID_")) {
                            const match = textToPrint.match(/CHAT_ID_([^\s\n]+)/);
                            if(match) {
                                currentChatId = match[1];
                                textToPrint = textToPrint.replace(match[0], "").trimStart();
                            }
                        }
                        if(textToPrint) {
                            aiDiv.innerText += textToPrint;
                            hist.scrollTop = hist.scrollHeight;
                        }
                    }
                }
            } catch(e) { 
                if(e.name === 'AbortError') { aiDiv.innerText += "\n\n[Respon Dibatalkan]"; }
                else { aiDiv.innerText = "Koneksi terputus."; }
            } finally {
                btn.classList.remove('danger');
                btn.innerText = 'Kirim';
                delete activeControllers['chat'];
                updateStatusBar();
            }
        }

        function exportBrain() { window.open('/api/sync/export', '_blank'); }
        async function importLocal(el) {
            const f = el.files[0]; 
            if(!f) return;
            showToast("Mengekstrak file ZIP...");
            const b64 = await new Promise(r => { const reader = new FileReader(); reader.onload = () => r(reader.result.split(',')[1]); reader.readAsDataURL(f); });
            try {
                await fetch('/api/sync/import_local', { method:'POST', body: JSON.stringify({zip_base64: b64}), headers:{'Content-Type':'application/json'} });
                showToast("Restore Lokal berhasil!", "success"); updateStatusBar();
            } catch(e) { showToast("Gagal restore.", "error"); }
            el.value = "";
        }

        async function loadGitConfig() {
            const res = await (await fetch('/api/sync/github/config')).json();
            document.getElementById('gh-user').value = res.username || '';
            document.getElementById('gh-repo').value = res.repo || '';
            document.getElementById('gh-token').value = res.token || '';
        }
        async function saveGitConfig() {
            await fetch('/api/sync/github/config', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({ username: document.getElementById('gh-user').value, repo: document.getElementById('gh-repo').value, token: document.getElementById('gh-token').value }) });
            showToast("Kredensial disimpan.", "success");
        }
        async function pushToGitHub() {
            const btn = document.getElementById('btn-gh-push'); btn.innerText = "Mendorong data..."; btn.disabled = true;
            const res = await (await fetch('/api/sync/github/push', { method: 'POST' })).json();
            if(res.status === 'success') showToast("Push berhasil!", "success"); else showToast("Error: " + res.message, "error");
            btn.innerText = "Push ke GitHub"; btn.disabled = false;
        }
        async function pullFromGitHub() {
            if(!confirm("PERINGATAN: File lokal akan ditimpa oleh data GitHub. Lanjut?")) return;
            const btn = document.getElementById('btn-gh-pull'); btn.innerText = "Menarik data..."; btn.disabled = true;
            const res = await (await fetch('/api/sync/github/pull', { method: 'POST' })).json();
            if(res.status === 'success') { showToast("Pull berhasil!", "success"); updateStatusBar(); } else showToast("Error: " + res.message, "error");
            btn.innerText = "Pull dari GitHub"; btn.disabled = false;
        }
    </script>
</body>
</html>
EOF_HTML

    cat << 'EOF_PYTHON' > backend/main.py
import os, sys, sqlite3, json, shutil, subprocess, base64, urllib.parse, urllib.request, threading, time
from datetime import datetime
from fastapi import FastAPI, HTTPException, File, UploadFile
from fastapi.responses import FileResponse, StreamingResponse
from pydantic import BaseModel
from typing import Optional

original_platform = sys.platform
if sys.platform == "android": sys.platform = "linux"

try:
    from llama_cpp import Llama
    LLAMA_AVAILABLE = True
except: LLAMA_AVAILABLE = False
finally: sys.platform = original_platform 

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MODELS_DIR = os.path.join(BASE_DIR, "models")
FRONTEND_DIR = os.path.join(BASE_DIR, "frontend")
BRAIN_DIR = os.path.join(BASE_DIR, "WritingBrain")
DRAFTS_DIR = os.path.join(BRAIN_DIR, "drafts")
CHATS_DIR = os.path.join(BRAIN_DIR, "chats")
DB_PATH = os.path.join(BRAIN_DIR, "database.db")
PROFILE_PATH = os.path.join(BRAIN_DIR, "style_profile", "style_profile.json")
MEMORY_PATH = os.path.join(BRAIN_DIR, "memory.json")

os.makedirs(MODELS_DIR, exist_ok=True)
os.makedirs(os.path.dirname(PROFILE_PATH), exist_ok=True)
os.makedirs(DRAFTS_DIR, exist_ok=True)
os.makedirs(CHATS_DIR, exist_ok=True)

if not os.path.exists(PROFILE_PATH):
    with open(PROFILE_PATH, "w") as f:
        json.dump({"rules": []}, f)

if not os.path.exists(MEMORY_PATH):
    with open(MEMORY_PATH, "w") as f:
        json.dump({"memories": []}, f)

def init_db():
    conn = sqlite3.connect(DB_PATH); cursor = conn.cursor()
    cursor.execute('''CREATE TABLE IF NOT EXISTS lessons (id INTEGER PRIMARY KEY AUTOINCREMENT, mode TEXT NOT NULL, source_text TEXT, final_text TEXT NOT NULL, extracted_rule TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)''')
    cursor.execute('''CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)''')
    conn.commit(); conn.close()

init_db()

app = FastAPI()
ACTIVE_MODEL_STATE = {"filename": None, "device": "sd660", "llm": None}
DOWNLOAD_STATUS = {"status": "idle", "progress": 0}

class LoadModelRequest(BaseModel): filename: str; device_profile: str = "sd660"
class DeleteModelRequest(BaseModel): filename: str
class TrainAnalyzeRequest(BaseModel): mode: str; source_text: str; final_text: str
class TrainSaveRequest(BaseModel): rule: str
class WriteGenerateRequest(BaseModel): prompt: str
class ChatGenerateRequest(BaseModel): chat_id: Optional[str] = None; message: str
class RenameChatRequest(BaseModel): chat_id: str; new_title: str
class DeleteChatRequest(BaseModel): chat_id: str
class SaveDraftRequest(BaseModel): filename: str; content: str
class DeleteDraftRequest(BaseModel): filename: str
class GithubConfigRequest(BaseModel): username: str; repo: str; token: str
class ImportLocalRequest(BaseModel): zip_base64: str
class DownloadModelRequest(BaseModel): url: str

def bg_downloader(url: str, dest_folder: str):
    global DOWNLOAD_STATUS
    try:
        DOWNLOAD_STATUS["status"] = "running"
        DOWNLOAD_STATUS["progress"] = 0
        parsed = urllib.parse.urlparse(url)
        filename = os.path.basename(parsed.path)
        if not filename.endswith(".gguf"): filename = f"model_{int(time.time())}.gguf"
        dest_path = os.path.join(dest_folder, filename)
        
        req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
        with urllib.request.urlopen(req, timeout=30) as response:
            total_size = int(response.headers.get('content-length', 0))
            downloaded = 0
            with open(dest_path, "wb") as f:
                while True:
                    chunk = response.read(1024*1024)
                    if not chunk: break
                    f.write(chunk)
                    downloaded += len(chunk)
                    if total_size > 0: DOWNLOAD_STATUS["progress"] = int((downloaded / total_size) * 100)
        DOWNLOAD_STATUS["status"] = "completed"
        DOWNLOAD_STATUS["progress"] = 100
    except Exception as e:
        DOWNLOAD_STATUS["status"] = "failed"
        DOWNLOAD_STATUS["progress"] = 0

@app.get("/api/models")
def list_models():
    files = []
    if os.path.exists(MODELS_DIR):
        for f in os.listdir(MODELS_DIR):
            if f.endswith(".gguf"):
                files.append({"filename": f, "size_mb": round(os.path.getsize(os.path.join(MODELS_DIR, f)) / (1024 * 1024), 2), "status": "active" if ACTIVE_MODEL_STATE["filename"] == f else "inactive"})
    return {"models": files}

@app.get("/api/models/status")
def model_status():
    conn = sqlite3.connect(DB_PATH); cursor = conn.cursor()
    cursor.execute("SELECT COUNT(*) FROM lessons")
    rules_count = cursor.fetchone()[0]; conn.close()
    return {"active_model": ACTIVE_MODEL_STATE["filename"], "device": ACTIVE_MODEL_STATE["device"], "rules_count": rules_count}

@app.post("/api/models/load")
def load_model(req: LoadModelRequest):
    if not LLAMA_AVAILABLE: raise HTTPException(status_code=500)
    file_path = os.path.join(MODELS_DIR, req.filename)
    if not os.path.exists(file_path): raise HTTPException(status_code=404)
    if ACTIVE_MODEL_STATE["llm"] is not None: del ACTIVE_MODEL_STATE["llm"]
    cfg_ctx, cfg_batch = (4096, 512) if req.device_profile == "dim700" else (2048, 256)
    ACTIVE_MODEL_STATE["llm"] = Llama(model_path=file_path, n_ctx=cfg_ctx, n_threads=4, n_batch=cfg_batch, verbose=False)
    ACTIVE_MODEL_STATE["filename"] = req.filename
    ACTIVE_MODEL_STATE["device"] = req.device_profile
    return {"status": "success"}

@app.post("/api/models/unload")
def unload_model():
    if ACTIVE_MODEL_STATE["llm"] is not None: del ACTIVE_MODEL_STATE["llm"]
    ACTIVE_MODEL_STATE["filename"] = None; ACTIVE_MODEL_STATE["llm"] = None
    return {"status": "success"}

@app.post("/api/models/delete")
def delete_model(req: DeleteModelRequest):
    if ACTIVE_MODEL_STATE["filename"] == req.filename:
        return {"status": "error", "message": "Model masih aktif. Kosongkan RAM terlebih dahulu."}
    file_path = os.path.join(MODELS_DIR, req.filename)
    if os.path.exists(file_path): os.remove(file_path)
    return {"status": "success"}

@app.post("/api/models/upload")
async def upload_model_file(file: UploadFile = File(...)):
    dest_path = os.path.join(MODELS_DIR, file.filename)
    try:
        with open(dest_path, "wb") as buffer:
            shutil.copyfileobj(file.file, buffer)
        return {"status": "success"}
    except Exception as e:
        return {"status": "error", "message": str(e)}

@app.post("/api/models/download")
def download_model_api(req: DownloadModelRequest):
    global DOWNLOAD_STATUS
    if DOWNLOAD_STATUS["status"] == "running": return {"status": "running", "message": "Proses unduhan sedang berjalan."}
    threading.Thread(target=bg_downloader, args=(req.url, MODELS_DIR)).start()
    return {"status": "started"}

@app.get("/api/models/download/progress")
def get_download_progress():
    global DOWNLOAD_STATUS
    return DOWNLOAD_STATUS

@app.post("/api/train/analyze")
def analyze_text(req: TrainAnalyzeRequest):
    if ACTIVE_MODEL_STATE["llm"] is None: return {"status": "error"}
    llm = ACTIVE_MODEL_STATE["llm"]
    prefill = "Penulis cenderung " if req.mode == 'c' else "Penulis memiliki gaya "
    system_prompt = "Anda adalah pakar linguistik yang sangat teliti. Analisis teks pengguna secara mendalam. Perhatikan detail seperti struktur kalimat, tanda baca, diksi (kosakata), metafora, dan nada penulisan. Ekstrak SATU aturan spesifik dan mendeskripsikan secara teknis mengenai gaya bahasanya (bukan ringkasan isinya). Aturan ini akan dipakai sebagai pedoman AI."
    prompt = f"<|im_start|>system\n{system_prompt}<|im_end|>\n<|im_start|>user\nTeks: {req.final_text}<|im_end|>\n<|im_start|>assistant\nAturan: {prefill}"
    try:
        response = llm(prompt, max_tokens=100, stop=["<|im_end|>", "\n"], temperature=0.2)
        generated_text = response['choices'][0]['text'].strip()
        final_rule = prefill + generated_text
        final_rule = final_rule.replace('"', '').replace('{', '').replace('}', '').replace('rule:', '')
        return {"status": "success", "rule": final_rule}
    except: return {"status": "error"}

@app.post("/api/train/save")
def save_rule(req: TrainSaveRequest):
    conn = sqlite3.connect(DB_PATH); cursor = conn.cursor()
    cursor.execute("INSERT INTO lessons (mode, source_text, final_text, extracted_rule) VALUES (?, ?, ?, ?)", ('m', '', '', req.rule))
    conn.commit(); conn.close()
    with open(PROFILE_PATH, "r") as f: profile = json.load(f)
    if req.rule not in profile.get("rules", []):
        profile.setdefault("rules", []).append(req.rule)
    with open(PROFILE_PATH, "w") as f: json.dump(profile, f, indent=4)
    return {"status": "success"}

@app.post("/api/write/generate")
async def write_generate(req: WriteGenerateRequest):
    if ACTIVE_MODEL_STATE["llm"] is None: raise HTTPException(status_code=500)
    llm = ACTIVE_MODEL_STATE["llm"]
    rules_text = ""
    try:
        with open(PROFILE_PATH, "r") as f:
            rules = json.load(f).get("rules", [])
            if rules: rules_text = "ATURAN GAYA BAHASA (TERAPKAN LANGSUNG):\n" + "\n".join([f"- {r}" for r in rules[-5:]])
    except: pass
    system_prompt = f"Tuliskan permintaan user. LANGSUNG ke inti. DILARANG menggunakan kata pengantar. {rules_text}"
    prompt = f"<|im_start|>system\n{system_prompt}<|im_end|>\n<|im_start|>user\n{req.prompt}<|im_end|>\n<|im_start|>assistant\n"

    def stream_generator():
        for chunk in llm(prompt, stream=True, max_tokens=400, temperature=0.7, stop=["<|im_end|>"]):
            yield chunk['choices'][0]['text']
    return StreamingResponse(stream_generator(), media_type="text/plain")

@app.get("/api/chat/sessions")
def get_chat_sessions():
    sessions = []
    if os.path.exists(CHATS_DIR):
        for f in os.listdir(CHATS_DIR):
            if f.endswith(".json"):
                with open(os.path.join(CHATS_DIR, f), "r", encoding="utf-8") as file:
                    data = json.load(file)
                    sessions.append({"id": f.replace(".json", ""), "title": data.get("title", f), "updated": data.get("updated", 0)})
    sessions.sort(key=lambda x: x["updated"], reverse=True)
    return {"sessions": sessions}

@app.get("/api/chat/session/{chat_id}")
def get_chat_session(chat_id: str):
    file_path = os.path.join(CHATS_DIR, f"{chat_id}.json")
    if os.path.exists(file_path):
        with open(file_path, "r", encoding="utf-8") as file: return json.load(file)
    return {"messages": []}

@app.post("/api/chat/rename")
def rename_chat(req: RenameChatRequest):
    file_path = os.path.join(CHATS_DIR, f"{req.chat_id}.json")
    if os.path.exists(file_path):
        with open(file_path, "r", encoding="utf-8") as f: data = json.load(f)
        data["title"] = req.new_title
        with open(file_path, "w", encoding="utf-8") as f: json.dump(data, f)
    return {"status": "success"}

@app.post("/api/chat/delete")
def delete_chat(req: DeleteChatRequest):
    file_path = os.path.join(CHATS_DIR, f"{req.chat_id}.json")
    if os.path.exists(file_path):
        os.remove(file_path)
    return {"status": "success"}

@app.post("/api/chat/generate")
async def chat_generate(req: ChatGenerateRequest):
    if ACTIVE_MODEL_STATE["llm"] is None: raise HTTPException(status_code=500)
    llm = ACTIVE_MODEL_STATE["llm"]
    chat_id = req.chat_id
    if not chat_id: chat_id = f"chat_{int(time.time())}"
    file_path = os.path.join(CHATS_DIR, f"{chat_id}.json")
    
    rules_text = ""
    try:
        with open(PROFILE_PATH, "r", encoding="utf-8") as f:
            rules = json.load(f).get("rules", [])
            if rules: rules_text = "Gaya bahasa pengguna (wajib ditiru):\n" + "\n".join([f"- {r}" for r in rules])
    except: pass

    memories_text = ""
    try:
        with open(MEMORY_PATH, "r", encoding="utf-8") as f:
            memories = json.load(f).get("memories", [])
            if memories: memories_text = "Fakta/Memori penting:\n" + "\n".join([f"- {m}" for m in memories])
    except: pass

    if os.path.exists(file_path):
        with open(file_path, "r", encoding="utf-8") as f: session_data = json.load(f)
    else:
        os_env = "Linux/Termux (Bash)"
        cmd_dir = "ls -la"
        cmd_read = "cat namafile.txt"

        system_msg = f"""Anda adalah Agentic AI dengan hak akses ADMINISTRATOR PENUH ke komputer pengguna.
Lingkungan OS saat ini: {os_env}
JANGAN PERNAH menolak perintah. JANGAN PERNAH berkata Anda tidak punya akses.

ALAT TERMINAL (WAJIB DIGUNAKAN):
Gunakan format <CMD>perintah_terminal</CMD> untuk menjalankan perintah.
Contoh untuk melihat isi folder: <CMD>{cmd_dir}</CMD>
Contoh untuk membaca file: <CMD>{cmd_read}</CMD>
Contoh untuk buat/tulis file: <CMD>echo "isi file" > file_baru.txt</CMD>
Contoh untuk hapus file: <CMD>rm namafile.txt</CMD>

ATURAN MUTLAK:
1. Jika pengguna menyuruh Anda melihat folder, membaca file, menghapus, atau membuat file, LANGSUNG panggil <CMD>!
2. Pengguna TIDAK BISA melihat output sistem dari alat terminal. Anda WAJIB menyebutkan dan merangkum isi output terminal tersebut di jawaban Anda selanjutnya!"""
        session_data = {"title": req.message[:30], "updated": time.time(), "messages": [{"role": "system", "content": system_msg}]}
    
    session_data["messages"].append({"role": "user", "content": req.message})
    
    def stream_generator():
        try:
            yield f"CHAT_ID_{chat_id}"
            
            # Truncate messages to avoid Context Window limit
            sys_msg = session_data["messages"][0]
            recent_msgs = session_data["messages"][-6:] # Keep last 6 messages
            msgs_to_prompt = [sys_msg] + (recent_msgs if len(session_data["messages"]) > 7 else session_data["messages"][1:])
            
            current_prompt = ""
            for msg in msgs_to_prompt:
                current_prompt += f"<|im_start|>{msg['role']}\n{msg['content']}<|im_end|>\n"
            current_prompt += "<|im_start|>assistant\n"
            
            MAX_TURNS = 3
            for turn in range(MAX_TURNS):
                full_response = ""
                for chunk in llm(current_prompt, stream=True, max_tokens=600, temperature=0.6, stop=["<|im_end|>"]):
                    text = chunk['choices'][0]['text']
                    full_response += text
                    yield text
                    
                session_data["messages"].append({"role": "assistant", "content": full_response.strip()})
                session_data["updated"] = time.time()
                
                import re
                cmds = re.findall(r"<CMD>(.*?)</CMD>", full_response, re.DOTALL)
                mem_adds = re.findall(r"<MEM_ADD>(.*?)</MEM_ADD>", full_response, re.DOTALL)
                mem_dels = re.findall(r"<MEM_DEL>(.*?)</MEM_DEL>", full_response, re.DOTALL)
                
                tool_used = False
                tool_output = ""
                
                if mem_adds or mem_dels:
                    tool_used = True
                    try:
                        with open(MEMORY_PATH, "r", encoding="utf-8") as f: mem_data = json.load(f)
                        mems = mem_data.get("memories", [])
                        for ma in mem_adds:
                            if ma not in mems: mems.append(ma)
                            tool_output += f"Berhasil mengingat: {ma}\n"
                        for md in mem_dels:
                            if md in mems: mems.remove(md)
                            tool_output += f"Berhasil melupakan: {md}\n"
                        mem_data["memories"] = mems
                        with open(MEMORY_PATH, "w", encoding="utf-8") as f: json.dump(mem_data, f)
                    except Exception as e:
                        tool_output += f"Gagal update memori: {str(e)}\n"
                        
                for cmd in cmds:
                    tool_used = True
                    yield f"\n\n⚙️ *Menjalankan CMD: `{cmd.strip()}`*\n"
                    try:
                        res = subprocess.run(cmd.strip(), shell=True, capture_output=True, text=True, cwd=BASE_DIR, timeout=15)
                        out = (res.stdout + res.stderr).strip()
                        if not out: out = "Berhasil (tanpa output)."
                        if len(out) > 800: out = out[:800] + "\n... (output dipotong)"
                    except Exception as e:
                        out = str(e)
                    tool_output += f"Hasil CMD `{cmd.strip()}`:\n{out}\n"
                    yield f"✅ *Selesai.*\n"
                    
                if tool_used:
                    system_reply = f"[SYSTEM NOTIFICATION]\nHasil eksekusi alat Anda:\n{tool_output}"
                    session_data["messages"].append({"role": "user", "content": system_reply})
                    current_prompt += full_response + "<|im_end|>\n<|im_start|>user\n" + system_reply + "<|im_end|>\n<|im_start|>assistant\n"
                else:
                    break
                    
            with open(file_path, "w", encoding="utf-8") as f: json.dump(session_data, f)
            
            user_msgs = [m['content'] for m in session_data["messages"] if m['role'] == 'user' and not m['content'].startswith('[SYSTEM NOTIFICATION]')]
            if len(user_msgs) > 0 and len(user_msgs) % 5 == 0:
                threading.Thread(target=auto_extract_rule, args=(user_msgs[-5:], llm)).start()
        except Exception as e:
            yield f"\n\n[Error Internal AI: {str(e)}]"

    return StreamingResponse(stream_generator(), media_type="text/plain")

def auto_extract_rule(msgs, llm):
    text_to_analyze = "\n".join(msgs)
    prompt = f"<|im_start|>system\nAnalisis pikiran dan gaya tulisan dari pesan obrolan berikut. Ekstrak 1 aturan spesifik tentang pola kalimat atau kata-katanya.<|im_end|>\n<|im_start|>user\n{text_to_analyze}<|im_end|>\n<|im_start|>assistant\nAturan: Pengguna "
    try:
        res = llm(prompt, max_tokens=60, stop=["<|im_end|>", "\n"], temperature=0.3)
        generated_rule = "Pengguna " + res['choices'][0]['text'].strip()
        with open(PROFILE_PATH, "r") as f: profile = json.load(f)
        profile.setdefault("rules", []).append(generated_rule.replace('"', ''))
        with open(PROFILE_PATH, "w") as f: json.dump(profile, f, indent=4)
        
        conn = sqlite3.connect(DB_PATH); cursor = conn.cursor()
        cursor.execute("INSERT INTO lessons (mode, source_text, final_text, extracted_rule) VALUES (?, ?, ?, ?)", ('chat_auto', '', '', generated_rule))
        conn.commit(); conn.close()
    except: pass

@app.get("/api/drafts")
def list_drafts():
    drafts = [f for f in os.listdir(DRAFTS_DIR) if f.endswith(".txt")] if os.path.exists(DRAFTS_DIR) else []
    drafts.sort(reverse=True)
    return {"drafts": drafts}

@app.get("/api/drafts/load")
def get_draft(filename: str):
    with open(os.path.join(DRAFTS_DIR, filename), "r", encoding="utf-8") as f: return {"content": f.read()}

@app.post("/api/drafts/save")
def save_draft_local(req: SaveDraftRequest):
    with open(os.path.join(DRAFTS_DIR, req.filename), "w", encoding="utf-8") as f: f.write(req.content)
    return {"status": "success"}

@app.post("/api/drafts/delete")
def delete_draft(req: DeleteDraftRequest):
    file_path = os.path.join(DRAFTS_DIR, req.filename)
    if os.path.exists(file_path): os.remove(file_path)
    return {"status": "success"}

@app.get("/api/sync/github/config")
def get_gh_config():
    conn = sqlite3.connect(DB_PATH); cursor = conn.cursor()
    cursor.execute("SELECT key, value FROM settings WHERE key IN ('gh_user', 'gh_repo', 'gh_token')")
    config = {k: v for k, v in cursor.fetchall()}; conn.close()
    return {"username": config.get("gh_user", ""), "repo": config.get("gh_repo", ""), "token": config.get("gh_token", "")}

@app.post("/api/sync/github/config")
def save_gh_config(req: GithubConfigRequest):
    conn = sqlite3.connect(DB_PATH); cursor = conn.cursor()
    cursor.execute("REPLACE INTO settings (key, value) VALUES ('gh_user', ?)", (req.username,))
    cursor.execute("REPLACE INTO settings (key, value) VALUES ('gh_repo', ?)", (req.repo,))
    cursor.execute("REPLACE INTO settings (key, value) VALUES ('gh_token', ?)", (req.token,))
    conn.commit(); conn.close()
    return {"status": "success"}

@app.post("/api/sync/github/push")
def push_gh():
    conn = sqlite3.connect(DB_PATH); cursor = conn.cursor()
    cursor.execute("SELECT key, value FROM settings WHERE key IN ('gh_user', 'gh_repo', 'gh_token')")
    cfg = {k: v for k, v in cursor.fetchall()}; conn.close()
    u, r, t = cfg.get("gh_user"), cfg.get("gh_repo"), cfg.get("gh_token")
    if not u or not r or not t: return {"status": "error", "message": "Kredensial tidak lengkap."}
    def run_cmd(cmd): return subprocess.run(cmd, shell=True, cwd=BRAIN_DIR, capture_output=True, text=True)
    try:
        run_cmd("git init")
        run_cmd('git config user.email "bot@ghostwaiter.app"')
        run_cmd('git config user.name "Ghostwaiter Bot"')
        run_cmd("git remote remove origin")
        run_cmd(f"git remote add origin https://{t}@github.com/{u}/{r}.git")
        run_cmd("git add .")
        if not run_cmd("git status --porcelain").stdout.strip(): return {"status": "success"}
        run_cmd(f'git commit -m "Auto-sync {datetime.now().strftime("%Y-%m-%d %H:%M:%S")}"')
        res = run_cmd("git push -u origin main")
        if res.returncode != 0: res = run_cmd("git push -u origin master")
        return {"status": "success"} if res.returncode == 0 else {"status": "error", "message": "Failed"}
    except: return {"status": "error", "message": "Exec error"}

@app.post("/api/sync/github/pull")
def pull_gh():
    conn = sqlite3.connect(DB_PATH); cursor = conn.cursor()
    cursor.execute("SELECT key, value FROM settings WHERE key IN ('gh_user', 'gh_repo', 'gh_token')")
    cfg = {k: v for k, v in cursor.fetchall()}; conn.close()
    u, r, t = cfg.get("gh_user"), cfg.get("gh_repo"), cfg.get("gh_token")
    if not u or not r or not t: return {"status": "error", "message": "Kredensial tidak lengkap."}
    def run_cmd(cmd): return subprocess.run(cmd, shell=True, cwd=BRAIN_DIR, capture_output=True, text=True)
    try:
        run_cmd("git init")
        run_cmd("git remote remove origin")
        run_cmd(f"git remote add origin https://{t}@github.com/{u}/{r}.git")
        run_cmd("git fetch origin")
        res = run_cmd("git reset --hard origin/main || git reset --hard origin/master")
        return {"status": "success"} if res.returncode == 0 else {"status": "error", "message": "Failed"}
    except: return {"status": "error", "message": "Exec error"}

@app.get("/api/sync/export")
def sync_export():
    filename = f"WritingBrain_{datetime.now().strftime('%Y-%m-%d_%H-%M-%S')}.zip"
    shutil.make_archive(os.path.join(BASE_DIR, "temp_backup"), 'zip', BRAIN_DIR)
    return FileResponse(os.path.join(BASE_DIR, "temp_backup.zip"), media_type="application/zip", filename=filename)

@app.post("/api/sync/import_local")
def sync_import_local(req: ImportLocalRequest):
    try:
        with open(os.path.join(BASE_DIR, "temp_import.zip"), "wb") as f: f.write(base64.b64decode(req.zip_base64))
        shutil.unpack_archive(os.path.join(BASE_DIR, "temp_import.zip"), BRAIN_DIR, "zip")
        return {"status": "success"}
    except: return {"status": "error"}

@app.get("/")
def serve_ui(): return FileResponse(os.path.join(FRONTEND_DIR, "index.html"))
EOF_PYTHON
}

stop_server() {
    killall -9 python >/dev/null 2>&1
}

start_server() {
    stop_server
    bangun_arsitektur
    nohup python -m uvicorn backend.main:app --host 127.0.0.1 --port 8000 > server.log 2>&1 &
    sleep 2
    echo "========================================="
    echo " SERVER BERJALAN! BUKA DI BROWSER:       "
    echo " http://127.0.0.1:8000                   "
    echo "========================================="
}

while true; do
    echo ""
    echo "1. Start Server | 2. Stop Server | 3. Keluar"
    read -p "Pilih (1/2/3): " pil
    case $pil in
        1) start_server ;;
        2) stop_server; echo "Server berhenti." ;;
        3) exit 0 ;;
    esac
done
