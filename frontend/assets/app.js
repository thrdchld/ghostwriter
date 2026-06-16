const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];

const state = {
  workspace: "writing",
  workspaces: [],
  currentChat: null,
  currentDraft: null,
  originalAiText: "",
  brain: null,
  brainTab: "style",
  saveTimer: null,
  deferredInstall: null,
  sessionToken: localStorage.getItem("ghostwriter:session") || "",
  markdownBuffer: "",
};

async function api(path, options = {}) {
  const config = {...options, credentials: "same-origin", headers: {...(options.headers || {})}};
  if (state.sessionToken) config.headers.Authorization = `Bearer ${state.sessionToken}`;
  
  config.headers["X-AI-Provider"] = "openrouter";
  const key = localStorage.getItem("ghostwriter:openrouter_key");
  const model = localStorage.getItem("ghostwriter:openrouter_model");
  if (key) config.headers["X-OpenRouter-Key"] = key;
  if (model) config.headers["X-OpenRouter-Model"] = model;

  if (config.body && !(config.body instanceof FormData)) {
    config.headers["Content-Type"] = "application/json";
    if (typeof config.body !== "string") config.body = JSON.stringify(config.body);
  }
  const response = await fetch(path, config);
  if (!response.ok) {
    let message = `Request failed (${response.status})`;
    try {
      const data = await response.json();
      message = data.message || data.detail?.message || data.detail || message;
    } catch (_) {}
    const error = new Error(message);
    error.status = response.status;
    throw error;
  }
  return response;
}

async function jsonApi(path, options = {}) {
  return (await api(path, options)).json();
}

function toast(message, type = "info") {
  const node = $("#toast");
  node.textContent = message;
  node.className = `toast ${type}`;
  clearTimeout(node.timer);
  node.timer = setTimeout(() => node.className = `toast ${type} hidden`, 2800);
}

function showConfirm(message) {
  return new Promise(resolve => {
    const modal = $("#confirm-modal");
    $("#confirm-message").textContent = message;
    modal.classList.remove("hidden");
    const cleanup = () => {
      modal.classList.add("hidden");
      $("#confirm-ok").removeEventListener("click", onOk);
      $("#confirm-cancel").removeEventListener("click", onCancel);
    };
    const onOk = () => { cleanup(); resolve(true); };
    const onCancel = () => { cleanup(); resolve(false); };
    $("#confirm-ok").addEventListener("click", onOk);
    $("#confirm-cancel").addEventListener("click", onCancel);
  });
}

function showPrompt(message, defaultValue = "") {
  return new Promise(resolve => {
    const modal = $("#prompt-modal");
    $("#prompt-message").textContent = message;
    const input = $("#prompt-input");
    input.value = defaultValue;
    modal.classList.remove("hidden");
    input.focus();
    const cleanup = () => {
      modal.classList.add("hidden");
      $("#prompt-ok").removeEventListener("click", onOk);
      $("#prompt-cancel").removeEventListener("click", onCancel);
    };
    const onOk = () => { cleanup(); resolve(input.value); };
    const onCancel = () => { cleanup(); resolve(null); };
    $("#prompt-ok").addEventListener("click", onOk);
    $("#prompt-cancel").addEventListener("click", onCancel);
  });
}

function escapeHtml(value = "") {
  return String(value).replace(/[&<>"']/g, char => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"}[char]));
}

function inlineMarkdown(value) {
  let output = value;
  output = output.replace(/`([^`]+)`/g, "<code>$1</code>");
  output = output.replace(/\*\*\*([^*]+)\*\*\*/g, "<strong><em>$1</em></strong>");
  output = output.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  output = output.replace(/__([^_]+)__/g, "<strong>$1</strong>");
  output = output.replace(/(^|[\s(])\*([^*\n]+)\*/g, "$1<em>$2</em>");
  output = output.replace(/(^|[\s(])_([^_\n]+)_/g, "$1<em>$2</em>");
  output = output.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (match, label, value) => {
    if (/&(?:quot|#x?0*22|apos|#x?0*27);/i.test(value)) return match;
    try {
      const url = new URL(value.replaceAll("&amp;", "&"));
      if (!["http:", "https:"].includes(url.protocol)) return match;
      return `<a href="${escapeHtml(url.href)}" target="_blank" rel="noopener noreferrer">${label}</a>`;
    } catch (_) {
      return match;
    }
  });
  return output;
}

function renderMarkdown(source = "") {
  source = source.replace(/<think>[\s\S]*?(<\/think>|$)/gi, '');
  const escaped = escapeHtml(source).replace(/\r\n?/g, "\n");
  const codeBlocks = [];
  const withoutCode = escaped.replace(/```([\w-]*)\n?([\s\S]*?)```/g, (_, language, code) => {
    const index = codeBlocks.length;
    codeBlocks.push(`<pre><code class="language-${language}">${code.trim()}</code></pre>`);
    return `@@CODEBLOCK_${index}@@`;
  });
  const lines = withoutCode.split("\n");
  const output = [];
  let listType = "";
  const closeList = () => {
    if (listType) output.push(`</${listType}>`);
    listType = "";
  };
  for (const line of lines) {
    const codeMatch = line.match(/^@@CODEBLOCK_(\d+)@@$/);
    if (codeMatch) {
      closeList();
      output.push(codeBlocks[Number(codeMatch[1])]);
      continue;
    }
    const heading = line.match(/^(#{1,3})\s+(.+)$/);
    if (heading) {
      closeList();
      const level = heading[1].length;
      output.push(`<h${level}>${inlineMarkdown(heading[2])}</h${level}>`);
      continue;
    }
    const unordered = line.match(/^\s*[-+*]\s+(.+)$/);
    const ordered = line.match(/^\s*\d+[.)]\s+(.+)$/);
    if (unordered || ordered) {
      const type = unordered ? "ul" : "ol";
      if (listType !== type) {
        closeList();
        output.push(`<${type}>`);
        listType = type;
      }
      output.push(`<li>${inlineMarkdown((unordered || ordered)[1])}</li>`);
      continue;
    }
    closeList();
    if (/^\s*---+\s*$/.test(line)) output.push("<hr>");
    else if (line.startsWith("&gt; ")) output.push(`<blockquote>${inlineMarkdown(line.slice(5))}</blockquote>`);
    else if (line.trim()) output.push(`<p>${inlineMarkdown(line)}</p>`);
  }
  closeList();
  return output.join("");
}

function openSheet(title, html) {
  $("#sheet-title").textContent = title;
  $("#sheet-content").innerHTML = html;
  $("#sheet").classList.remove("hidden");
  $("#backdrop").classList.remove("hidden");
}

function closeSheet() {
  $("#sheet").classList.add("hidden");
  $("#backdrop").classList.add("hidden");
}

function showView(view) {
  $$(".view").forEach(node => node.classList.toggle("active", node.id === `view-${view}`));
  $$(".nav-item").forEach(node => node.classList.toggle("active", node.dataset.view === view));
  localStorage.setItem("ghostwriter:activeView", view);
  if (view === "brain") loadBrain();
  if (view === "menu") Promise.all([loadModelStatus(), loadSyncStatus()]);
}

async function initialize() {
  const auth = await jsonApi("/api/auth/status");
  if (!auth.authenticated) {
    $("#login-screen").classList.remove("hidden");
    return;
  }
  $("#app").classList.remove("hidden");
  
  applyTheme();
  let sidebarState = localStorage.getItem("ghostwriter:sidebar") || "expanded";
  if (window.innerWidth <= 780) sidebarState = "minimized";
  
  if (sidebarState === "minimized") {
    $("#sidebar").classList.add("minimized");
    $("#sidebar").classList.remove("expanded");
    $("#app").classList.add("sidebar-minimized");
  } else {
    $("#app").classList.remove("sidebar-minimized");
    $("#sidebar").classList.remove("minimized");
    $("#sidebar").classList.add("expanded");
  }

  const lastView = localStorage.getItem("ghostwriter:activeView") || "chat";
  showView(lastView);
  await loadWorkspaces();
  await Promise.all([loadModelStatus(), loadSyncStatus()]);
  restoreLocalDraft();
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("/service-worker.js");
}

let theme = localStorage.getItem("ghostwriter:theme") || "system";

function applyTheme() {
  if (theme === "system") {
    document.documentElement.removeAttribute("data-theme");
    if ($("#theme-detail")) $("#theme-detail").textContent = "Sistem (Otomatis)";
  } else if (theme === "dark") {
    document.documentElement.setAttribute("data-theme", "dark");
    if ($("#theme-detail")) $("#theme-detail").textContent = "Gelap (Dark)";
  } else {
    document.documentElement.setAttribute("data-theme", "light");
    if ($("#theme-detail")) $("#theme-detail").textContent = "Terang (Light)";
  }
  localStorage.setItem("ghostwriter:theme", theme);
}

function cycleTheme() {
  if (theme === "system") theme = "dark";
  else if (theme === "dark") theme = "light";
  else theme = "system";
  applyTheme();
}

function toggleSidebar() {
  const sidebar = $("#sidebar");
  sidebar.classList.toggle("minimized");
  sidebar.classList.toggle("expanded");
  const isMinimized = sidebar.classList.contains("minimized");
  localStorage.setItem("ghostwriter:sidebar", isMinimized ? "minimized" : "expanded");
  $("#app").classList.toggle("sidebar-minimized", isMinimized);
}

async function loadWorkspaces() {
  const [list, current] = await Promise.all([
    jsonApi("/api/workspace/list"),
    jsonApi("/api/workspace/current"),
  ]);
  state.workspaces = list.items;
  state.workspace = current.id;
  $("#workspace-name").textContent = current.name;
}

function showWorkspaceSheet() {
  const items = state.workspaces.map(item => `
    <button class="sheet-option workspace-option" data-id="${escapeHtml(item.id)}" type="button">
      <span><strong>${escapeHtml(item.name)}</strong><small>${escapeHtml(item.id)}</small></span>
      <b>${item.id === state.workspace ? "✓" : ""}</b>
    </button>`).join("");
  openSheet("Pilih workspace", `${items}
    <button id="create-workspace" class="button primary" style="width:100%;margin-top:16px" type="button">Workspace baru</button>`);
  $$(".workspace-option").forEach(button => button.onclick = () => switchWorkspace(button.dataset.id));
  $("#create-workspace").onclick = createWorkspace;
}

async function switchWorkspace(id) {
  await jsonApi("/api/workspace/switch", {method: "POST", body: {workspace_id: id}});
  state.workspace = id;
  state.currentChat = null;
  state.currentDraft = null;
  const item = state.workspaces.find(workspace => workspace.id === id);
  $("#workspace-name").textContent = item?.name || id;
  resetChat();
  restoreLocalDraft();
  closeSheet();
  await Promise.all([loadBrain(), loadSyncStatus()]);
    toast("Workspace switched");
}

async function createWorkspace(customName = null) {
  const name = customName || await showPrompt("Nama workspace baru:");
  if (!name?.trim()) return;
  try {
    const result = await jsonApi("/api/workspace/create", {method: "POST", body: {name: name.trim()}});
    state.workspaces.push(result.workspace);
    await switchWorkspace(result.workspace.id);
  } catch (error) {
    toast(error.message, "error");
  }
}

function appendMessage(role, content = "") {
  const messages = $("#chat-messages");
  if (messages.querySelector(".empty-state")) messages.innerHTML = "";
  const node = document.createElement("div");
  node.className = `message ${role}`;
  if (role === "assistant") {
    node.innerHTML = `<div class="msg-content">${renderMarkdown(content)}</div><button class="chat-copy-btn" type="button" aria-label="Copy" onclick="navigator.clipboard.writeText(this.previousElementSibling.innerText.trim()); toast('Message copied', 'success')">📋 Copy</button>`;
  } else {
    node.textContent = content;
  }
  messages.appendChild(node);
  node.scrollIntoView({behavior: "smooth", block: "end"});
  return node;
}

async function sendChat(event) {
  event.preventDefault();
  const input = $("#chat-input");
  const message = input.value.trim();
  if (!message) return;
  appendMessage("user", message);
  input.value = "";
  input.style.height = "auto";
  const assistant = appendMessage("assistant", "");
  let fullResponse = "";
  $("#chat-send").disabled = true;
  try {
    const response = await api("/api/chat/send", {
      method: "POST",
      body: {workspace_id: state.workspace, chat_id: state.currentChat, message},
    });
    state.currentChat = response.headers.get("X-Chat-Id");
    if ($("#chat-title").textContent === "Obrolan baru") $("#chat-title").textContent = message.slice(0, 60);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    while (true) {
      const {value, done} = await reader.read();
      if (done) break;
      fullResponse += decoder.decode(value, {stream: true});
      assistant.querySelector(".msg-content").innerHTML = renderMarkdown(fullResponse);
      assistant.scrollIntoView({block: "end"});
    }
  } catch (error) {
    if (error.message.includes("Semua model inference gagal")) {
      if (!fullResponse.trim()) assistant.querySelector(".msg-content").innerHTML = renderMarkdown("*(Jaringan AI sedang sibuk atau kuota habis, coba lagi nanti)*");
    } else {
      if (fullResponse.trim()) {
        toast(`Connection lost: ${error.message}`, "error");
      } else {
        assistant.querySelector(".msg-content").innerHTML = renderMarkdown(`**Error:** ${error.message}`);
      }
    }
  } finally {
    $("#chat-send").disabled = false;
    setTimeout(async () => {
      const previous = state.brain?.pending_proposals || 0;
      try {
        const profile = await jsonApi(`/api/brain/profile?workspace_id=${encodeURIComponent(state.workspace)}`);
        state.brain = profile;
        $("#proposal-count").textContent = profile.pending_proposals ? `(${profile.pending_proposals})` : "";
        if (profile.pending_proposals > previous) toast("New learning proposals to review");
      } catch (_) {}
    }, 4500);
  }
}

function resetChat() {
  state.currentChat = null;
  $("#chat-title").textContent = "Obrolan baru";
  $("#chat-messages").innerHTML = `<div class="empty-state"><strong>Mulai dari sebuah pemikiran.</strong><span>Diskusikan ide, susun argumen, atau minta umpan balik.</span></div>`;
}

async function showChatList() {
  try {
    openSheet("Riwayat chat", `<div class="sheet-tabs"><button id="active-chat-tab" class="chip active">Aktif</button><button id="archive-chat-tab" class="chip">Arsip</button></div><div id="chat-list-content"></div><button id="new-chat" class="button primary" style="width:100%;margin-top:16px">Obrolan baru</button>`);
    $("#active-chat-tab").onclick = () => renderChatHistory(false);
    $("#archive-chat-tab").onclick = () => renderChatHistory(true);
    $("#new-chat").onclick = () => { resetChat(); closeSheet(); };
    await renderChatHistory(false);
  } catch (error) {
    toast(error.message);
  }
}

async function renderChatHistory(archived) {
  const data = await jsonApi(`/api/chat/list?workspace_id=${encodeURIComponent(state.workspace)}&archived=${archived}`);
  $("#active-chat-tab").classList.toggle("active", !archived);
  $("#archive-chat-tab").classList.toggle("active", archived);
  $("#chat-list-content").innerHTML = data.items.map(item => `
    <div class="chat-row">
      <button class="sheet-option ${archived ? "" : "chat-option"}" data-id="${escapeHtml(item.id)}" type="button">
        <span><strong>${escapeHtml(item.title)}</strong><small>${item.messages.length} pesan · ${new Date(item.updated_at).toLocaleString("id-ID")}</small></span>
      </button>
      <div class="row-actions">
        ${archived
          ? `<button class="mini-button restore-chat" data-id="${escapeHtml(item.id)}">Restore</button><button class="mini-button danger purge-chat" data-id="${escapeHtml(item.id)}">Hapus</button>`
          : `<button class="mini-button rename-chat" data-id="${escapeHtml(item.id)}" data-title="${escapeHtml(item.title)}">Edit</button><button class="mini-button danger archive-chat" data-id="${escapeHtml(item.id)}">Arsip</button>`}
      </div>
    </div>`).join("") || `<p class="empty-state" style="min-height:180px">${archived ? "Arsip kosong." : "Belum ada riwayat."}</p>`;
  $$(".chat-option").forEach(button => button.onclick = () => loadChat(button.dataset.id));
  $$(".rename-chat").forEach(button => button.onclick = () => renameChat(button.dataset.id, button.dataset.title));
  $$(".archive-chat").forEach(button => button.onclick = () => archiveChat(button.dataset.id));
  $$(".restore-chat").forEach(button => button.onclick = () => restoreChat(button.dataset.id));
  $$(".purge-chat").forEach(button => button.onclick = () => purgeChat(button.dataset.id));
}

async function renameChat(id, oldTitle) {
  const title = await showPrompt("Nama chat:", oldTitle);
  if (!title?.trim()) return;
  await jsonApi("/api/chat/rename", {method: "POST", body: {workspace_id: state.workspace, chat_id: id, title: title.trim()}});
  if (state.currentChat === id) $("#chat-title").textContent = title.trim();
  await renderChatHistory(false);
}

async function archiveChat(id) {
  if (!(await showConfirm("Pindahkan chat ini ke arsip?"))) return;
  await jsonApi("/api/chat/archive", {method: "POST", body: {workspace_id: state.workspace, chat_id: id}});
  if (state.currentChat === id) resetChat();
  await renderChatHistory(false);
}

async function restoreChat(id) {
  await jsonApi("/api/chat/restore", {method: "POST", body: {workspace_id: state.workspace, chat_id: id}});
  await renderChatHistory(true);
  toast("Chat restored");
}

async function purgeChat(id) {
  if (!(await showConfirm("Hapus permanen chat ini? Backup internal tetap dibuat, tetapi tidak tersedia dari UI."))) return;
  await jsonApi("/api/chat/delete-permanent", {method: "POST", body: {workspace_id: state.workspace, chat_id: id}});
  await renderChatHistory(true);
}

async function loadChat(id) {
  const chat = await jsonApi(`/api/chat/session/${encodeURIComponent(id)}?workspace_id=${encodeURIComponent(state.workspace)}`);
  state.currentChat = id;
  $("#chat-title").textContent = chat.title;
  $("#chat-messages").innerHTML = "";
  chat.messages.forEach(message => appendMessage(message.role, message.content));
  closeSheet();
}

async function generateWriting() {
  const prompt = $("#write-prompt").value.trim();
  if (!prompt) return toast("Write an instruction first");
  const button = $("#generate-button");
  button.disabled = true;
  button.textContent = "Menulis...";
  $("#draft-content").value = "";
  state.originalAiText = "";
  try {
    const activeModeNode = document.querySelector("#write-mode .chip.active");
    const mode = activeModeNode ? activeModeNode.dataset.mode : "write";
    const response = await api("/api/ai/generate", {
      method: "POST",
      body: {workspace_id: state.workspace, prompt, mode},
    });
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    while (true) {
      const {value, done} = await reader.read();
      if (done) break;
      let chunk = decoder.decode(value, {stream: true});
      chunk = chunk.replace(/[*#_\[\]`]/g, ""); // Strip markdown
      $("#draft-content").value += chunk;
      $("#draft-content").scrollTop = $("#draft-content").scrollHeight;
    }
    state.originalAiText = $("#draft-content").value;
    scheduleDraftSave();
    saveUndoState();
    updateWordCount();
  } catch (error) {
    if (error.message.includes("All inference models failed")) {
      toast("AI network is busy, please try again later");
    } else {
      toast(error.message, "error");
    }
  } finally {
    button.disabled = false;
    button.textContent = "Generate";
  }
}

function localDraftKey() {
  return `ghostwriter:draft:${state.workspace}`;
}

function saveDraftLocally() {
  localStorage.setItem(localDraftKey(), JSON.stringify({
    id: state.currentDraft,
    title: $("#draft-title").value,
    content: $("#draft-content").value,
    prompt: $("#write-prompt").value,
    savedAt: Date.now(),
  }));
}

function restoreLocalDraft() {
  const raw = localStorage.getItem(localDraftKey());
  if (!raw) {
    state.currentDraft = null;
    $("#draft-title").value = "Untitled";
    $("#draft-content").value = "";
    $("#write-prompt").value = "";
    return;
  }
  try {
    const draft = JSON.parse(raw);
    state.currentDraft = draft.id;
    $("#draft-title").value = draft.title || "Untitled";
    $("#draft-content").value = draft.content || "";
    $("#write-prompt").value = draft.prompt || "";
    $("#save-state").textContent = "Dipulihkan dari perangkat";
  } catch (_) {}
  
  undoStack.length = 0;
  undoIndex = -1;
  saveUndoState();
  updateWordCount();
}

function scheduleDraftSave() {
  saveDraftLocally();
  $("#save-state").textContent = navigator.onLine ? "Menyimpan..." : "Tersimpan offline";
  clearTimeout(state.saveTimer);
  state.saveTimer = setTimeout(saveDraftToServer, 1200);
}

async function saveDraftToServer() {
  if (!navigator.onLine) return;
  const title = $("#draft-title").value.trim() || "Untitled";
  const content = $("#draft-content").value;
  try {
    if (!state.currentDraft) {
      const draft = await jsonApi("/api/draft/create", {
        method: "POST", body: {workspace_id: state.workspace, title},
      });
      state.currentDraft = draft.id;
    }
    await jsonApi("/api/draft/update", {
      method: "POST",
      body: {workspace_id: state.workspace, draft_id: state.currentDraft, title, content},
    });
    saveDraftLocally();
    $("#save-state").textContent = "Tersimpan";
    loadSyncStatus();
  } catch (error) {
    $("#save-state").textContent = "Tersimpan offline";
  }
}

async function showDraftList() {
  const data = await jsonApi(`/api/draft/list?workspace_id=${encodeURIComponent(state.workspace)}`);
  const html = data.items.map(item => `
    <button class="sheet-option draft-option" data-id="${escapeHtml(item.id)}" type="button">
      <span><strong>${escapeHtml(item.title)}</strong><small>${new Date(item.updated_at).toLocaleString("id-ID")}</small></span><b>›</b>
    </button>`).join("") || `<p class="empty-state" style="min-height:180px">Belum ada draft.</p>`;
  openSheet("Draft", html);
  $$(".draft-option").forEach(button => button.onclick = () => loadDraft(button.dataset.id));
}

async function loadDraft(id) {
  const draft = await jsonApi(`/api/draft/${encodeURIComponent(id)}?workspace_id=${encodeURIComponent(state.workspace)}`);
  state.currentDraft = draft.id;
  state.originalAiText = draft.content;
  $("#draft-title").value = draft.title;
  $("#draft-content").value = draft.content;
  $("#save-state").textContent = "Tersimpan";
  saveDraftLocally();
  closeSheet();
}

async function trainRevision() {
  const revised = $("#draft-content").value.trim();
  if (!state.originalAiText || !revised) return toast("Generate writing then edit before Training");
  if (revised === state.originalAiText.trim()) return toast("No revisions available to learn");
  const button = $("#train-button");
  button.disabled = true;
  button.textContent = "Learning...";
  try {
    const result = await jsonApi("/api/brain/learn/revision", {
      method: "POST",
      body: {workspace_id: state.workspace, ai_output: state.originalAiText, user_revision: revised},
    });
    state.originalAiText = revised;
    toast(`${result.analysis.style_rules.length + result.analysis.thinking_patterns.length} patterns learned`);
  } catch (error) {
    toast(error.message);
  } finally {
    button.disabled = false;
    button.textContent = "Train";
  }
}

async function loadBrain() {
  try {
    state.brain = await jsonApi(`/api/brain/profile?workspace_id=${encodeURIComponent(state.workspace)}`);
    $("#style-count").textContent = state.brain.style_profile.rules.length;
    $("#thinking-count").textContent = state.brain.thinking_profile.patterns.length;
    $("#revision-count").textContent = state.brain.revision_count;
    $("#proposal-count").textContent = state.brain.pending_proposals ? `(${state.brain.pending_proposals})` : "";
    renderBrainTab();
  } catch (error) {
    toast(error.message);
  }
}

function renderBrainTab() {
  if (!state.brain) return;
  $("#brain-list").classList.toggle("hidden", ["raw", "compare", "references", "proposals"].includes(state.brainTab));
  $("#brain-teach").classList.toggle("hidden", state.brainTab !== "raw");
  $("#brain-compare").classList.toggle("hidden", state.brainTab !== "compare");
  $("#reference-search").classList.toggle("hidden", state.brainTab !== "references");
  $("#proposal-list").classList.toggle("hidden", state.brainTab !== "proposals");
  let items = [];
  if (state.brainTab === "style") items = state.brain.style_profile.rules;
  if (state.brainTab === "thinking") items = state.brain.thinking_profile.patterns;
  $("#brain-list").innerHTML = items.map(item => `<article class="insight">${escapeHtml(item)}</article>`).join("")
    || `<div class="empty-state" style="min-height:240px"><strong>Belum ada pola.</strong><span>Train revisi atau ajarkan contoh tulisan Anda.</span></div>`;
}

async function loadProposals() {
  try {
    const data = await jsonApi(`/api/brain/proposals?workspace_id=${encodeURIComponent(state.workspace)}&status=pending`);
    $("#proposal-list").innerHTML = data.items.map(item => `
      <article class="proposal-card" data-id="${escapeHtml(item.id)}">
        <label>${escapeHtml(item.type)}</label>
        <textarea class="proposal-content">${escapeHtml(item.content)}</textarea>
        <div class="proposal-actions">
          <button class="button mini-button reject-proposal" type="button">Tolak</button>
          <button class="button primary approve-proposal" type="button">Setujui</button>
        </div>
      </article>`).join("") || `<div class="empty-state" style="min-height:220px"><strong>Tidak ada usulan.</strong><span>Usulan baru muncul setelah sistem menganalisis percakapan.</span></div>`;
    $$(".approve-proposal").forEach(button => button.onclick = () => decideProposal(button, true));
    $$(".reject-proposal").forEach(button => button.onclick = () => decideProposal(button, false));
  } catch (error) {
    toast(error.message);
  }
}

async function decideProposal(button, approve) {
  const card = button.closest(".proposal-card");
  const body = {workspace_id: state.workspace, proposal_id: card.dataset.id};
  if (approve) body.content = card.querySelector(".proposal-content").value.trim();
  if (approve && !body.content) return toast("Proposal content cannot be empty");
  button.disabled = true;
  try {
    await jsonApi(`/api/brain/proposals/${approve ? "approve" : "reject"}`, {method: "POST", body});
    await Promise.all([loadProposals(), loadBrain()]);
    toast(approve ? "Learning approved" : "Proposal rejected");
  } catch (error) {
    toast(error.message);
  }
}

async function learnRawWriting() {
  const content = $("#raw-writing").value.trim();
  if (!content) return toast("Enter a writing sample");
  const button = $("#learn-raw-button");
  button.disabled = true;
  button.textContent = "Menganalisis...";
  try {
    const result = await jsonApi("/api/brain/learn/raw-writing", {
      method: "POST", body: {workspace_id: state.workspace, content, type: "user"},
    });
    $("#raw-writing").value = "";
    state.brainTab = "style";
    $$(".chip").forEach(c => c.classList.toggle("active", c.dataset.brainTab === "style"));
    await loadBrain();
    toast(`${result.analysis.style_rules.length} patterns learned`);
  } catch (error) {
    toast(error.message);
  } finally {
    button.disabled = false;
    button.textContent = "Analisis tulisan";
  }
}

async function compareRevision() {
  const original = $("#compare-original").value.trim();
  const edited = $("#compare-edited").value.trim();
  if (!original || !edited) return toast("Fill in the original and edited texts");
  const button = $("#compare-button");
  button.disabled = true;
  button.textContent = "Menganalisis...";
  try {
    const result = await jsonApi("/api/brain/compare-revision", {
      method: "POST", body: {workspace_id: state.workspace, ai_output: original, user_revision: edited}
    });
    const proposals = result.analysis.style_rules.map(r => ({type: "Style Rule", content: r}))
      .concat(result.analysis.thinking_patterns.map(p => ({type: "Thinking Pattern", content: p})));
    $("#compare-proposals").innerHTML = proposals.map((p) => `
      <article class="proposal-card">
        <label>${p.type}</label>
        <textarea class="compare-proposal-content" data-type="${p.type === 'Style Rule' ? 'style' : 'thinking'}">${escapeHtml(p.content)}</textarea>
      </article>`).join("") || "<p class='empty-state' style='min-height:100px'>Tidak ada perbedaan signifikan.</p>";
    $("#compare-results").classList.remove("hidden");
  } catch (error) {
    toast(error.message);
  } finally {
    button.disabled = false;
    button.textContent = "Analisis Perubahan";
  }
}

async function commitCompare() {
  const button = $("#commit-compare-button");
  button.disabled = true;
  button.textContent = "Menyimpan...";
  const style_rules = [];
  const thinking_patterns = [];
  $$(".compare-proposal-content").forEach(el => {
    const text = el.value.trim();
    if (text) {
      if (el.dataset.type === "style") style_rules.push(text);
      else thinking_patterns.push(text);
    }
  });
  try {
    await jsonApi("/api/brain/commit-revision", {
      method: "POST", body: {workspace_id: state.workspace, analysis: {style_rules, thinking_patterns}}
    });
    toast("Patterns successfully learned", "success");
    $("#compare-original").value = "";
    $("#compare-edited").value = "";
    $("#compare-results").classList.add("hidden");
    state.brainTab = "style";
    $$(".chip").forEach(c => c.classList.toggle("active", c.dataset.brainTab === "style"));
    await loadBrain();
  } catch (error) {
    toast(error.message);
  } finally {
    button.disabled = false;
    button.textContent = "Simpan & Train";
  }
}

async function searchReferences() {
  const query = $("#reference-query").value.trim();
  if (!query) return;
  $("#reference-button").disabled = true;
  try {
    const data = await jsonApi("/api/reference/search", {
      method: "POST", body: {workspace_id: state.workspace, query, auto_save: true},
    });
    renderReferences(data.items);
    toast(`${data.items.length} references saved`);
  } catch (error) {
    toast(error.message);
  } finally {
    $("#reference-button").disabled = false;
  }
}

function renderReferences(items) {
  $("#reference-list").innerHTML = items.map(item => `
    <article class="reference-item">
      <a href="${escapeHtml(item.url)}" target="_blank" rel="noopener">${escapeHtml(item.title)}</a>
      <p>${escapeHtml(item.summary)}</p>
    </article>`).join("");
}

async function loadReferences() {
  try {
    const data = await jsonApi(`/api/reference/list?workspace_id=${encodeURIComponent(state.workspace)}`);
    renderReferences(data.items);
  } catch (_) {}
}

async function loadModelStatus() {
  try {
    const data = await jsonApi("/api/model/status");
    $("#model-status").className = `status-pill ${data.configured ? "ok" : "error"}`;
    $("#model-status span").textContent = data.configured ? "AI" : "No token";
    $("#model-detail").textContent = data.active_model;
  } catch (_) {}
}

async function loadSyncStatus() {
  try {
    const data = await jsonApi("/api/sync/status");
    const pill = $("#sync-status");
    pill.className = `status-pill ${data.queue_size ? "warn" : "ok"}`;
    pill.querySelector("span").textContent = data.queue_size ? `${data.queue_size} pending` : "Synced";
    $("#sync-detail").textContent = data.configured ? `${data.queue_size} perubahan menunggu` : "Secret GitHub belum dikonfigurasi";
  } catch (_) {}
}

async function showModelSheet() {
  const status = await jsonApi("/api/model/status");
  openSheet("Model AI", `
    <div id="model-chain"></div>
    <div class="model-search"><input id="model-query" placeholder="Cari model di Hugging Face"><button id="model-search-button" class="button primary compact">Cari</button></div>
    <div id="model-results" class="model-results"></div>`);
  renderModelChain(status);
  $("#model-search-button").onclick = searchModels;
  $("#model-query").onkeydown = event => { if (event.key === "Enter") searchModels(); };
}

function renderModelChain(status) {
  $("#model-chain").innerHTML = status.fallback_chain.map((model, index) => `
    <div class="model-row">
      <div class="sheet-option"><span><strong>${escapeHtml(model)}</strong><small>${index === 0 ? "Default" : `Fallback ${index}`}${model === status.active_model ? " · aktif" : ""}</small></span></div>
      <div class="row-actions">
        <button class="mini-button test-model" data-model="${escapeHtml(model)}">Test</button>
        ${index > 0 ? `${index > 1 ? `<button class="mini-button move-model" data-index="${index}" data-delta="-1">↑</button>` : ""}<button class="mini-button default-model" data-model="${escapeHtml(model)}">Default</button><button class="mini-button danger remove-model" data-model="${escapeHtml(model)}">×</button>` : ""}
        ${index > 0 && index < status.fallback_chain.length - 1 ? `<button class="mini-button move-model" data-index="${index}" data-delta="1">↓</button>` : ""}
      </div>
    </div>`).join("");
  $$(".test-model").forEach(button => button.onclick = () => testModel(button.dataset.model, button));
  $$(".default-model").forEach(button => button.onclick = () => setDefaultModel(button.dataset.model));
  $$(".remove-model").forEach(button => button.onclick = () => removeModel(button.dataset.model));
  $$(".move-model").forEach(button => button.onclick = () => moveModel(status.fallback_chain, Number(button.dataset.index), Number(button.dataset.delta)));
}

async function refreshModelSheet() {
  const status = await jsonApi("/api/model/status");
  renderModelChain(status);
  loadModelStatus();
}

async function searchModels() {
  const query = $("#model-query").value.trim();
  if (query.length < 2) return toast("Enter at least 2 characters");
  $("#model-search-button").disabled = true;
  $("#model-results").innerHTML = "<p>Mencari...</p>";
  try {
    const data = await jsonApi(`/api/model/search?query=${encodeURIComponent(query)}`);
    $("#model-results").innerHTML = data.items.map(item => `
      <article class="model-result">
        <strong>${escapeHtml(item.id)}</strong>
        <small>${Number(item.downloads || 0).toLocaleString("id-ID")} downloads · ${Number(item.likes || 0).toLocaleString("id-ID")} likes${item.gated ? " · gated" : ""}</small>
        <div class="row-actions">
          <button class="mini-button search-test" data-model="${escapeHtml(item.id)}">Test</button>
          <button class="mini-button primary search-default" data-model="${escapeHtml(item.id)}">Jadikan default</button>
          <button class="mini-button search-fallback" data-model="${escapeHtml(item.id)}">Tambah fallback</button>
        </div>
      </article>`).join("") || "<p>Tidak ada model ditemukan.</p>";
    $$(".search-test").forEach(button => button.onclick = () => testModel(button.dataset.model, button));
    $$(".search-default").forEach(button => button.onclick = () => setDefaultModel(button.dataset.model));
    $$(".search-fallback").forEach(button => button.onclick = () => addFallbackModel(button.dataset.model));
  } catch (error) {
    $("#model-results").innerHTML = "";
    toast(error.message);
  } finally {
    $("#model-search-button").disabled = false;
  }
}

async function testModel(model, button) {
  const original = button.textContent;
  button.disabled = true;
  button.textContent = "...";
  try {
    await jsonApi("/api/model/test", {method: "POST", body: {model_id: model}});
    toast(`${model} is available`);
  } catch (error) {
    toast(error.message);
  } finally {
    button.disabled = false;
    button.textContent = original;
  }
}

async function setDefaultModel(model) {
  await jsonApi("/api/model/set-default", {method: "POST", body: {model_id: model}});
  await refreshModelSheet();
  toast("Default model updated");
}

async function addFallbackModel(model) {
  await jsonApi("/api/model/add-fallback", {method: "POST", body: {model_id: model}});
  await refreshModelSheet();
  toast("Model added to fallback");
}

async function removeModel(model) {
  await jsonApi("/api/model/remove", {method: "POST", body: {model_id: model}});
  await refreshModelSheet();
  toast("Model removed from fallback");
}

async function moveModel(chain, index, delta) {
  const target = index + delta;
  if (target < 0 || target >= chain.length) return;
  const reordered = [...chain];
  [reordered[index], reordered[target]] = [reordered[target], reordered[index]];
  await jsonApi("/api/model/reorder", {method: "POST", body: {models: reordered}});
  await refreshModelSheet();
}

async function manualSync() {
  if (!(await showConfirm("Sync ke GitHub sekarang?"))) return;
  try {
    $("#manual-sync").disabled = true;
    await jsonApi("/api/sync/run", {method: "POST"});
    toast("Sync complete", "success");
    await loadSyncStatus();
  } catch (error) {
    toast(error.message, "error");
  } finally {
    $("#manual-sync").disabled = false;
  }
}



function bindEvents() {
  document.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && e.shiftKey) {
      const el = e.target;
      if (el.tagName === "TEXTAREA" || el.tagName === "INPUT") {
        e.preventDefault();
        const form = el.closest("form");
        if (form) form.requestSubmit();
        else if (el.id === "write-prompt") $("#generate-button").click();
        else if (el.id === "raw-writing") $("#learn-raw-button").click();
        else if (el.id === "compare-original" || el.id === "compare-edited") $("#compare-button").click();
        else if (el.id === "reference-query") $("#reference-button").click();
        else if (el.classList.contains("proposal-content")) el.closest(".proposal-card").querySelector(".approve-proposal").click();
      }
    }
  });

  $$(".nav-item").forEach(button => button.onclick = () => { showView(button.dataset.view); if (window.innerWidth <= 780) toggleSidebar(); });
  if ($("#sidebar-toggle")) $("#sidebar-toggle").onclick = toggleSidebar;
  if ($("#mobile-sidebar-toggle")) $("#mobile-sidebar-toggle").onclick = toggleSidebar;
  if ($("#sidebar-backdrop")) $("#sidebar-backdrop").onclick = toggleSidebar;
  if ($("#theme-button")) $("#theme-button").onclick = cycleTheme;
  
  $$("#write-mode .chip").forEach(chip => {
    chip.onclick = () => {
      $$("#write-mode .chip").forEach(c => c.classList.remove("active"));
      chip.classList.add("active");
    };
  });

  // OpenRouter Settings Logic
  const orKeyInput = $("#openrouter-key");
  const orModelDisplay = $("#active-model-display");
  const loadModelsBtn = $("#load-models-btn");
  const modelsBrowser = $("#models-browser");
  const modelsList = $("#models-list");
  const modelSearch = $("#model-search");
  
  let allModels = [];
  let currentTab = "all"; // all, free, paid

  orKeyInput.value = localStorage.getItem("ghostwriter:openrouter_key") || "";
  orModelDisplay.textContent = localStorage.getItem("ghostwriter:openrouter_model") || "None";
  
  orKeyInput.addEventListener("input", () => {
    localStorage.setItem("ghostwriter:openrouter_key", orKeyInput.value.trim());
  });

  function renderModels() {
    modelsList.innerHTML = "";
    const query = modelSearch.value.toLowerCase();
    
    let filtered = allModels.filter(m => m.id.toLowerCase().includes(query) || m.name.toLowerCase().includes(query));
    
    if (currentTab === "free") {
      filtered = filtered.filter(m => parseFloat(m.pricing?.prompt || -1) === 0 && parseFloat(m.pricing?.completion || -1) === 0);
    } else if (currentTab === "paid") {
      filtered = filtered.filter(m => parseFloat(m.pricing?.prompt || 0) > 0 || parseFloat(m.pricing?.completion || 0) > 0);
    }

    filtered.forEach(model => {
      const isFree = parseFloat(model.pricing?.prompt || -1) === 0 && parseFloat(model.pricing?.completion || -1) === 0;
      const el = document.createElement("div");
      el.className = "model-result";
      el.style.cursor = "pointer";
      el.innerHTML = `
        <div style="display: flex; justify-content: space-between;">
          <strong>${model.name}</strong>
          <span style="font-size: 11px; background: var(--bg-muted); padding: 2px 6px; border-radius: 4px;">${isFree ? "Free" : "Paid"}</span>
        </div>
        <small>${model.id}</small>
      `;
      el.onclick = () => {
        localStorage.setItem("ghostwriter:openrouter_model", model.id);
        orModelDisplay.textContent = model.id;
        toast(`Model updated: ${model.id}`, "success");
      };
      modelsList.appendChild(el);
    });
  }

  modelSearch.addEventListener("input", renderModels);

  $$("#models-browser .chip[data-model-tab]").forEach(tab => {
    tab.onclick = () => {
      $$("#models-browser .chip[data-model-tab]").forEach(c => c.classList.remove("active"));
      tab.classList.add("active");
      currentTab = tab.dataset.modelTab;
      renderModels();
    };
  });

  loadModelsBtn.onclick = async () => {
    const key = orKeyInput.value.trim();
    if (!key) return toast("Enter OpenRouter API Key first", "error");
    
    loadModelsBtn.disabled = true;
    loadModelsBtn.textContent = "Loading...";
    try {
      const res = await fetch("https://openrouter.ai/api/v1/models", {
        headers: { "Authorization": `Bearer ${key}` }
      });
      const data = await res.json();
      allModels = data.data || [];
      modelsBrowser.classList.remove("hidden");
      renderModels();
      toast(`Loaded ${allModels.length} models`, "success");
    } catch (err) {
      toast("Failed to load models", "error");
    } finally {
      loadModelsBtn.disabled = false;
      loadModelsBtn.textContent = "Load";
    }
  };

  $("#workspace-button").onclick = showWorkspaceSheet;
  $("#sheet-close").onclick = closeSheet;
  $("#backdrop").onclick = closeSheet;
  $("#chat-form").onsubmit = sendChat;
  $("#chat-list-button").onclick = showChatList;
  $("#generate-button").onclick = generateWriting;
  $("#draft-list-button").onclick = showDraftList;
  $("#draft-title").addEventListener("input", scheduleDraftSave);
  $("#draft-content").addEventListener("input", () => {
    scheduleDraftSave();
    updateWordCount();
    clearTimeout(state.undoTimer);
    state.undoTimer = setTimeout(saveUndoState, 1000);
  });
  $("#draft-content").addEventListener("keydown", event => {
    if ((event.ctrlKey || event.metaKey) && event.key === "z") {
      event.preventDefault();
      if (event.shiftKey) redoDraft();
      else undoDraft();
    }
    if ((event.ctrlKey || event.metaKey) && event.key === "y") {
      event.preventDefault();
      redoDraft();
    }
  });
  $("#write-prompt").addEventListener("input", saveDraftLocally);
  $("#copy-button").onclick = async () => { await navigator.clipboard.writeText($("#draft-content").value); toast("Copied"); };
  $("#train-button").onclick = trainRevision;
  $("#refresh-brain").onclick = loadBrain;
  $$(".chip").forEach(chip => chip.onclick = () => {
    $$(".chip").forEach(c => c.classList.remove("active"));
    chip.classList.add("active");
    state.brainTab = chip.dataset.brainTab;
    renderBrainTab();
    if (state.brainTab === "references") loadReferences();
    if (state.brainTab === "proposals") loadProposals();
  });
  
  $("#import-button").onclick = () => $("#import-file").click();
  $("#compare-button").onclick = compareRevision;
  $("#commit-compare-button").onclick = commitCompare;
  $("#import-file").onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    toast("Importing data...");
    try {
      const formData = new FormData();
      formData.append("file", file);
      const headers = {};
      const token = localStorage.getItem("ghostwriter:token");
      if (token) headers["Authorization"] = `Bearer ${token}`;
      
      const response = await fetch("/api/import", { method: "POST", headers, body: formData });
      if (!response.ok) throw await response.json().catch(() => ({message: `HTTP ${response.status}`}));
      toast("Import successful! Reloading...", "success");
      setTimeout(() => window.location.reload(), 1500);
    } catch (err) {
      toast("Failed to import file: " + err.message, "error");
    }
    e.target.value = "";
  };

  $("#learn-raw-button").onclick = learnRawWriting;
  $("#reference-button").onclick = searchReferences;
  $("#model-button").onclick = showModelSheet;
  $("#model-status").onclick = showModelSheet;
  $("#sync-status").onclick = manualSync;
  $("#manual-sync").onclick = manualSync;

  $("#logout-button").onclick = async () => {
    await jsonApi("/api/auth/logout", {method: "POST"});
    localStorage.removeItem("ghostwriter:session");
    state.sessionToken = "";
    location.reload();
  };
  $("#login-form").onsubmit = async event => {
    event.preventDefault();
    try {
      const result = await jsonApi("/api/auth/login", {method: "POST", body: {password: $("#login-password").value}});
      state.sessionToken = result.session_token || "";
      if (state.sessionToken) localStorage.setItem("ghostwriter:session", state.sessionToken);
      $("#login-screen").classList.add("hidden");
      $("#app").classList.remove("hidden");
      await loadWorkspaces();
      await Promise.all([loadModelStatus(), loadSyncStatus()]);
      restoreLocalDraft();
      if ("serviceWorker" in navigator) navigator.serviceWorker.register("/service-worker.js");
    } catch (error) {
      $("#login-error").textContent = error.message;
    }
  };
  $("#chat-input").addEventListener("input", event => {
    event.target.style.height = "auto";
    event.target.style.height = `${Math.min(event.target.scrollHeight, 130)}px`;
  });
  window.addEventListener("beforeinstallprompt", event => {
    event.preventDefault();
    state.deferredInstall = event;
    $("#install-button").classList.remove("hidden");
  });
  $("#install-button").onclick = async () => {
    await state.deferredInstall?.prompt();
    state.deferredInstall = null;
    $("#install-button").classList.add("hidden");
  };
  window.addEventListener("online", saveDraftToServer);
}

const undoStack = [];
let undoIndex = -1;

function saveUndoState() {
  const content = $("#draft-content").value;
  if (undoIndex >= 0 && undoStack[undoIndex] === content) return;
  undoStack.length = undoIndex + 1;
  undoStack.push(content);
  undoIndex++;
  if (undoStack.length > 50) { undoStack.shift(); undoIndex--; }
}

function undoDraft() {
  if (undoIndex > 0) {
    undoIndex--;
    $("#draft-content").value = undoStack[undoIndex];
    scheduleDraftSave();
    updateWordCount();
  }
}

function redoDraft() {
  if (undoIndex < undoStack.length - 1) {
    undoIndex++;
    $("#draft-content").value = undoStack[undoIndex];
    scheduleDraftSave();
    updateWordCount();
  }
}

function updateWordCount() {
  const text = $("#draft-content").value || "";
  const chars = text.length;
  const words = text.trim() ? text.trim().split(/\s+/).length : 0;
  $("#word-count").textContent = `${words} words · ${chars} characters`;
}

bindEvents();
initialize().catch(error => {
  if (error.status === 401) $("#login-screen").classList.remove("hidden");
  else toast(error.message);
});
