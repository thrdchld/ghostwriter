const $ = selector => document.querySelector(selector);
let chatAbortController = null;
let generateAbortController = null;
const $$ = selector => [...document.querySelectorAll(selector)];

const state = {
  workspace: "writing",
  workspaces: [],
  currentChat: null,
  currentDraft: null,
  originalAiText: "",
  brain: null,
  proposals: [],
  brainTab: "style",
  saveTimer: null,
  deferredInstall: null,
  sessionToken: localStorage.getItem("ghostwriter:session") || "",
  markdownBuffer: "",
};

async function api(path, options = {}) {
  const config = {...options, credentials: "same-origin", headers: {...(options.headers || {})}};
  if (state.sessionToken) config.headers.Authorization = `Bearer ${state.sessionToken}`;
  
  const provider = localStorage.getItem("ghostwriter:ai_provider") || "openrouter";
  const key = localStorage.getItem(`ghostwriter:key_${provider}`) || localStorage.getItem("ghostwriter:openrouter_key") || "";
  const model = localStorage.getItem("ghostwriter:openrouter_model") || "";
  config.headers["X-AI-Provider"] = provider;
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


function updateModelIndicator() {
  const provider = localStorage.getItem("ghostwriter:ai_provider") || "openrouter";
  const key = localStorage.getItem(`ghostwriter:key_${provider}`) || localStorage.getItem("ghostwriter:openrouter_key") || "";
  const model = localStorage.getItem("ghostwriter:openrouter_model") || "";
  const btn = $("#model-status");
  if (!btn) return;
  const icon = btn.querySelector("i");
  const label = btn.querySelector("span");
  const PROVIDER_LABELS = { openrouter: "OR", google: "Gemini", groq: "Groq", deepseek: "DS", mistral: "Mistral", kilo: "Kilo" };
  if (key && model) {
    if (icon) { icon.style.background = "#22c55e"; icon.style.boxShadow = "0 0 6px #22c55e88"; }
    const shortModel = model.split("/").pop();
    if (label) label.textContent = shortModel.length > 16 ? shortModel.slice(0, 14) + "…" : shortModel;
    btn.title = `${provider}: ${model}`;
  } else {
    if (icon) { icon.style.background = ""; icon.style.boxShadow = ""; }
    if (label) label.textContent = PROVIDER_LABELS[provider] || "AI";
    btn.title = "Click to configure AI in Settings";
  }
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
  if (view === "menu") Promise.all([loadSyncStatus()]);
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
  await Promise.all([loadSyncStatus()]);
  restoreLocalDraft();
  updateModelIndicator();
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
    <div style="display:flex; justify-content:space-between; align-items:center; border-bottom: 1px solid var(--border);">
      <button class="sheet-option workspace-option" data-id="${escapeHtml(item.id)}" type="button" style="flex:1; border-bottom:none;">
        <span><strong>${escapeHtml(item.name)}</strong><small>${escapeHtml(item.id)}</small></span>
        <b>${item.id === state.workspace ? "✓" : ""}</b>
      </button>
      <div style="padding-right: 16px; display:flex; gap:8px;">
         <button class="text-button accent" onclick="editWorkspace('${escapeHtml(item.id)}', '${escapeHtml(item.name).replace(/'/g, "\\'")}')" style="font-size:12px; padding:4px 8px;">Edit</button>
         ${item.id === 'writing' ? '' : `<button class="text-button danger" onclick="deleteWorkspace('${escapeHtml(item.id)}')" style="font-size:12px; padding:4px 8px; color:var(--error);">Hapus</button>`}
      </div>
    </div>`).join("");
  openSheet("Pilih workspace", `${items}
    <button id="create-workspace" class="button primary" style="width:100%;margin-top:16px" type="button">New Workspace</button>`);
  $$(".workspace-option").forEach(button => button.onclick = () => switchWorkspace(button.dataset.id));
  $("#create-workspace").onclick = () => createWorkspace();
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
    toast("Workspace diubah");
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
  
  if (chatAbortController) {
    chatAbortController.abort();
    return;
  }
  
  if (!message) return;
  appendMessage("user", message);
  input.value = "";
  input.style.height = "auto";
  const assistant = appendMessage("assistant", "");
  let fullResponse = "";
  
  const sendBtn = $("#chat-send");
  sendBtn.textContent = "⏹";
  sendBtn.setAttribute("aria-label", "Berhenti");
  
  chatAbortController = new AbortController();

  try {
    const response = await api("/api/chat/send", {
      method: "POST",
      body: {workspace_id: state.workspace, chat_id: state.currentChat, message},
      signal: chatAbortController.signal,
    });
    state.currentChat = response.headers.get("X-Chat-Id");
    if ($("#chat-title").textContent === "Chat Baru") $("#chat-title").textContent = message.slice(0, 60);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    while (true) {
      const {value, done} = await reader.read();
      if (done) break;
      fullResponse += decoder.decode(value, {stream: true});
      assistant.querySelector(".msg-content").innerHTML = renderMarkdown(fullResponse);
      // Smooth auto-scroll: forcefully scroll to bottom during streaming
      const msgs = $("#chat-messages");
      msgs.scrollTop = msgs.scrollHeight;
    }
  } catch (error) {
    if (error.name === "AbortError") {
      toast("Dibatalkan");
    } else if (error.message.includes("Semua model inference gagal")) {
      if (!fullResponse.trim()) assistant.querySelector(".msg-content").innerHTML = renderMarkdown("*(Jaringan AI sibuk atau kuota habis, silakan coba lagi nanti)*");
    } else {
      if (fullResponse.trim()) {
        toast(`Koneksi terputus: ${error.message}`, "error");
      } else {
        assistant.querySelector(".msg-content").innerHTML = renderMarkdown(`**Error:** ${error.message}`);
      }
    }
  } finally {
    chatAbortController = null;
    const sendBtn = $("#chat-send");
    sendBtn.textContent = "↑";
    sendBtn.setAttribute("aria-label", "Kirim");
    sendBtn.disabled = false;
    setTimeout(async () => {
      const previous = state.brain?.pending_proposals || 0;
      try {
        const profile = await jsonApi(`/api/brain/profile?workspace_id=${encodeURIComponent(state.workspace)}`);
        state.brain = profile;
        $("#proposal-count").textContent = profile.pending_proposals ? `(${profile.pending_proposals})` : "";
        if (profile.pending_proposals > previous) toast("Ada proposal pembelajaran baru untuk ditinjau");
      } catch (_) {}
    }, 4500);
  }
}

function resetChat() {
  state.currentChat = null;
  $("#chat-title").textContent = "Chat Baru";
  $("#chat-messages").innerHTML = `<div class="empty-state"><strong>Start with a thought.</strong><span>Discuss ideas, structure arguments, or request feedback.</span></div>`;
}

async function showChatList() {
  try {
    openSheet("Riwayat Chat", `<div class="sheet-tabs"><button id="active-chat-tab" class="chip active">Active</button><button id="archive-chat-tab" class="chip">Archive</button></div><div id="chat-list-content"></div>`);
    $("#active-chat-tab").onclick = () => renderChatHistory(false);
    $("#archive-chat-tab").onclick = () => renderChatHistory(true);
    
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
        <span><strong>${escapeHtml(item.title)}</strong><small>${item.messages.length} messages · ${new Date(item.updated_at).toLocaleString("en-US")}</small></span>
      </button>
      <div class="row-actions">
        ${archived
          ? `<button class="mini-button restore-chat" data-id="${escapeHtml(item.id)}">Restore</button><button class="mini-button danger purge-chat" data-id="${escapeHtml(item.id)}">Delete</button>`
          : `<button class="mini-button rename-chat" data-id="${escapeHtml(item.id)}" data-title="${escapeHtml(item.title)}">Edit</button><button class="mini-button danger archive-chat" data-id="${escapeHtml(item.id)}">Archive</button>`}
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
  if (!(await showConfirm("Arsipkan chat ini?"))) return;
  await jsonApi("/api/chat/archive", {method: "POST", body: {workspace_id: state.workspace, chat_id: id}});
  if (state.currentChat === id) resetChat();
  await renderChatHistory(false);
}

async function restoreChat(id) {
  await jsonApi("/api/chat/restore", {method: "POST", body: {workspace_id: state.workspace, chat_id: id}});
  await renderChatHistory(true);
  toast("Chat dipulihkan");
}

async function purgeChat(id) {
  if (!(await showConfirm("Hapus chat ini secara permanen?"))) return;
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
  if (generateAbortController) {
    generateAbortController.abort();
    return;
  }
  const prompt = $("#write-prompt").value.trim();
  if (!prompt) return toast("Tulis instruksi terlebih dahulu");
  const button = $("#generate-button");
  button.textContent = "Berhenti";
  $("#draft-content").value = "";
  state.originalAiText = "";
  
  generateAbortController = new AbortController();

  try {
    const activeModeNode = document.querySelector("#write-mode .chip.active");
    const mode = activeModeNode ? activeModeNode.dataset.mode : "write";
    const response = await api("/api/ai/generate", {
      method: "POST",
      body: {workspace_id: state.workspace, prompt, mode},
      signal: generateAbortController.signal,
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
    if (error.name === "AbortError") {
      toast("Dibatalkan");
    } else if (error.message.includes("All inference models failed") || error.message.includes("Semua model inference gagal")) {
      toast("Jaringan AI sibuk, silakan coba lagi nanti");
    } else {
      toast(error.message, "error");
    }
  } finally {
    generateAbortController = null;
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
      <span><strong>${escapeHtml(item.title)}</strong><small>${new Date(item.updated_at).toLocaleString("en-US")}</small></span><b>›</b>
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
  if (!state.originalAiText || !revised) return toast("Generate tulisan lalu edit sebelum Melatih");
  if (revised === state.originalAiText.trim()) return toast("Tidak ada revisi untuk dipelajari");
  const button = $("#train-button");
  button.disabled = true;
  button.textContent = "Mempelajari...";
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
  
  const list = $("#brain-list");
  if (state.brainTab === "style") {
    const items = state.brain.style_profile.rules || [];
    list.innerHTML = items.length ? items.map(item => `
      <article class="insight-card">
        <p>${escapeHtml(item)}</p>
        <div class="insight-meta" style="display:flex; gap:12px; margin-top:8px;">
          <button class="text-button compact" onclick="editBrainItem('style', '${escapeHtml(item).replace(/'/g, "\\'")}', '${escapeHtml(item).replace(/'/g, "\\'")}')">Edit</button>
          <button class="text-button compact danger" onclick="deleteBrainItem('style', '${escapeHtml(item).replace(/'/g, "\\'")}')">Hapus</button>
        </div>
      </article>`).join("") : `<div class="empty-state" style="min-height:240px"><strong>Belum ada pola.</strong><span>Latih revisi atau sediakan sampel tulisan.</span></div>`;
  } else if (state.brainTab === "thinking") {
    const items = state.brain.thinking_profile.patterns || [];
    list.innerHTML = items.length ? items.map(item => `
      <article class="insight-card">
        <p>${escapeHtml(item)}</p>
        <div class="insight-meta" style="display:flex; gap:12px; margin-top:8px;">
          <button class="text-button compact" onclick="editBrainItem('thinking', '${escapeHtml(item).replace(/'/g, "\\'")}', '${escapeHtml(item).replace(/'/g, "\\'")}')">Edit</button>
          <button class="text-button compact danger" onclick="deleteBrainItem('thinking', '${escapeHtml(item).replace(/'/g, "\\'")}')">Hapus</button>
        </div>
      </article>`).join("") : `<div class="empty-state" style="min-height:240px"><strong>Belum ada pola pemikiran.</strong></div>`;
  } else if (state.brainTab === "memory") {
    const mems = state.brain.memory || [];
    const convMems = state.brain.conversation_memory || [];
    const allMems = [...mems, ...convMems];
    list.innerHTML = allMems.length ? allMems.map(item => `
      <article class="insight-card">
        <p>${escapeHtml(item.content)}</p>
        <div class="insight-meta" style="display:flex; gap:12px; margin-top:8px;">
          <button class="text-button compact" onclick="editBrainItem('memory', '${escapeHtml(item.id)}', '${escapeHtml(item.content).replace(/'/g, "\\'")}')">Edit</button>
          <button class="text-button compact danger" onclick="deleteBrainItem('memory', '${escapeHtml(item.id)}')">Hapus</button>
        </div>
      </article>`).join("") : `<div class="empty-state" style="min-height:240px"><strong>Belum ada memori.</strong></div>`;
  }
}

async function loadProposals() {
  try {
    const data = await jsonApi(`/api/brain/proposals?workspace_id=${encodeURIComponent(state.workspace)}&status=pending`);
    state.proposals = data.items || [];
    const bulkDiv = $("#proposal-bulk-actions");
    if (bulkDiv) bulkDiv.style.display = state.proposals.length > 0 ? "flex" : "none";
    $("#proposal-list").innerHTML = state.proposals.map(item => `
      <article class="proposal-card" data-id="${escapeHtml(item.id)}">
        <label>${escapeHtml(item.type)}</label>
        <textarea class="proposal-content">${escapeHtml(item.content)}</textarea>
        <div class="proposal-actions">
          <button class="button mini-button reject-proposal" type="button">Tolak</button>
          <button class="button primary approve-proposal" type="button">Setujui</button>
        </div>
      </article>`).join("") || `<div class="empty-state" style="min-height:220px"><strong>No proposals.</strong><span>New proposals will appear after the system analyzes conversations.</span></div>`;
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
  if (approve && !body.content) return toast("Konten proposal tidak boleh kosong");
  button.disabled = true;
  try {
    await jsonApi(`/api/brain/proposals/${approve ? "approve" : "reject"}`, {method: "POST", body});
    await Promise.all([loadProposals(), loadBrain()]);
    toast(approve ? "Pembelajaran disetujui" : "Proposal ditolak");
  } catch (error) {
    toast(error.message);
  }
}

async function learnRawWriting() {
  const content = $("#raw-writing").value.trim();
  if (!content) return toast("Masukkan sampel tulisan");
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
  if (!original || !edited) return toast("Isi teks asli dan teks yang diedit");
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
      </article>`).join("") || "<p class='empty-state' style='min-height:100px'>No significant differences.</p>";
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
    toast("Pola berhasil dipelajari", "success");
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



async function loadSyncStatus() {
  try {
    const data = await jsonApi("/api/sync/status");
    const pill = $("#sync-status");
    pill.className = `status-pill ${data.queue_size ? "warn" : "ok"}`;
    pill.querySelector("span").textContent = data.queue_size ? `${data.queue_size} pending` : "Synced";
    $("#sync-detail").textContent = data.configured ? `${data.queue_size} pending changes` : "Rahasia GitHub belum dikonfigurasi";
  } catch (_) {}
}



function manualSync() {
  $("#sync-modal").classList.remove("hidden");
  
  $("#sync-cancel").onclick = () => $("#sync-modal").classList.add("hidden");
  
  $("#sync-push-btn").onclick = async () => {
    $("#sync-modal").classList.add("hidden");
    if (!(await showConfirm("Data di GitHub akan ditimpa seluruhnya dengan data lokal Anda saat ini. Lanjutkan Push?"))) return;
    try {
      $("#manual-sync").disabled = true;
      toast("Mengirim data ke GitHub...", "info");
      await jsonApi("/api/sync/push", {method: "POST"});
      toast("Sinkronisasi Push selesai", "success");
      await loadSyncStatus();
    } catch (error) {
      toast(error.message, "error");
    } finally {
      $("#manual-sync").disabled = false;
    }
  };

  $("#sync-pull-btn").onclick = async () => {
    $("#sync-modal").classList.add("hidden");
    if (!(await showConfirm("Data lokal Anda akan ditimpa dengan data dari GitHub. Tindakan ini tidak dapat dibatalkan. Lanjutkan Pull?"))) return;
    try {
      $("#manual-sync").disabled = true;
      toast("Mengambil data dari GitHub...", "info");
      await jsonApi("/api/sync/pull", {method: "POST"});
      toast("Sinkronisasi Pull selesai. Memuat ulang aplikasi...", "success");
      setTimeout(() => location.reload(), 1500);
    } catch (error) {
      toast(error.message, "error");
    } finally {
      $("#manual-sync").disabled = false;
    }
  };
}



function bindEvents() {
  if ($("#model-status")) $("#model-status").onclick = () => { const provider = localStorage.getItem("ghostwriter:ai_provider") || "openrouter"; const m = localStorage.getItem("ghostwriter:openrouter_model"); const k = localStorage.getItem(`ghostwriter:key_${provider}`) || localStorage.getItem("ghostwriter:openrouter_key"); toast(m && k ? `${provider.toUpperCase()} · ${m}` : "AI belum dikonfigurasi — buka Pengaturan → Provider AI", m && k ? "success" : "error"); };
  if ($("#new-chat-button")) $("#new-chat-button").onclick = () => { resetChat(); closeSheet(); };
  document.addEventListener("keydown", (e) => {
    const el = e.target;
    const isTextField = el && (el.tagName === "TEXTAREA" || el.tagName === "INPUT");
    const isLikelyDesktop =
      window.matchMedia("(hover: hover) and (pointer: fine)").matches ||
      navigator.maxTouchPoints === 0 ||
      window.innerWidth >= 1024;

    if (!isTextField || !el) return;

    const isEnter = e.key === "Enter" && !e.altKey && !e.ctrlKey && !e.metaKey;
    const isSubmitField =
      el.id === "chat-input" ||
      el.id === "write-prompt" ||
      el.id === "raw-writing" ||
      el.id === "compare-original" ||
      el.id === "compare-edited" ||
      el.id === "reference-query";

    if (isEnter && !e.shiftKey && isSubmitField) {
      e.preventDefault();
      if (el.id === "chat-input") el.closest("form")?.requestSubmit();
      else if (el.id === "write-prompt") $("#generate-button")?.click();
      else if (el.id === "raw-writing") $("#learn-raw-button")?.click();
      else if (el.id === "compare-original" || el.id === "compare-edited") $("#compare-button")?.click();
      else if (el.id === "reference-query") $("#reference-button")?.click();
      return;
    }

    if (isEnter && !e.shiftKey && el.classList.contains("proposal-content")) {
      e.preventDefault();
      el.closest(".proposal-card")?.querySelector(".approve-proposal")?.click();
      return;
    }

    if (isEnter && !e.shiftKey && el.tagName === "TEXTAREA" && !isLikelyDesktop) {
      e.preventDefault();
      const selectionStart = el.selectionStart;
      const selectionEnd = el.selectionEnd;
      el.value = `${el.value.slice(0, selectionStart)}\n${el.value.slice(selectionEnd)}`;
      el.selectionStart = el.selectionEnd = selectionStart + 1;
      return;
    }

    if (isEnter && e.shiftKey && el.tagName === "TEXTAREA") {
      e.preventDefault();
      const selectionStart = el.selectionStart;
      const selectionEnd = el.selectionEnd;
      el.value = `${el.value.slice(0, selectionStart)}\n${el.value.slice(selectionEnd)}`;
      el.selectionStart = el.selectionEnd = selectionStart + 1;
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

  // ── Multi-Provider AI Settings ───────────────────────────────────────────
  const PROVIDER_MODEL_URLS = {
    openrouter: async (key) => {
      const res = await fetch("https://openrouter.ai/api/v1/models", { headers: { Authorization: `Bearer ${key}` } });
      const data = await res.json();
      return (data.data || []).map(m => ({ id: m.id, name: m.name || m.id }));
    },
    google: async (key) => {
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(key)}`);
      const data = await res.json();
      return (data.models || [])
        .filter(m => m.supportedGenerationMethods?.includes("generateContent"))
        .map(m => ({ id: m.name.replace("models/", ""), name: m.displayName || m.name }));
    },
    groq: async (key) => {
      const res = await fetch("https://api.groq.com/openai/v1/models", { headers: { Authorization: `Bearer ${key}` } });
      const data = await res.json();
      return (data.data || []).map(m => ({ id: m.id, name: m.id }));
    },
    deepseek: async (key) => {
      const res = await fetch("https://api.deepseek.com/v1/models", { headers: { Authorization: `Bearer ${key}` } });
      const data = await res.json();
      return (data.data || []).map(m => ({ id: m.id, name: m.id }));
    },
    mistral: async (key) => {
      const res = await fetch("https://api.mistral.ai/v1/models", { headers: { Authorization: `Bearer ${key}` } });
      const data = await res.json();
      return (data.data || []).map(m => ({ id: m.id, name: m.id }));
    },
    kilo: async (key) => {
      try {
        const res = await fetch("https://api.kilo.ai/v1/models", { headers: { Authorization: `Bearer ${key}` } });
        const data = await res.json();
        return (data.data || []).map(m => ({ id: m.id, name: m.id }));
      } catch (err) {
        return [
          {id: "kilo-1", name: "Kilo 1"}, 
          {id: "kilo-search", name: "Kilo Search"}, 
          {id: "kilo-reasoning", name: "Kilo Reasoning"}
        ];
      }
    },
  };

  const providerSelect   = $("#ai-provider-select");
  const apiKeyInput      = $("#ai-api-key");
  const orModelDisplay   = $("#active-model-display");
  const loadModelsBtn    = $("#load-models-btn");
  const modelsBrowser    = $("#models-browser");
  const modelsList       = $("#models-list");
  const modelSearch      = $("#model-search");

  let allModels = [];

  // Restore saved state
  const savedProvider = localStorage.getItem("ghostwriter:ai_provider") || "openrouter";
  const savedKey      = localStorage.getItem(`ghostwriter:key_${savedProvider}`) || "";
  const savedModel    = localStorage.getItem("ghostwriter:openrouter_model") || "";
  if (providerSelect) providerSelect.value = savedProvider;
  if (apiKeyInput)    apiKeyInput.value    = savedKey;
  if (orModelDisplay) orModelDisplay.textContent = savedModel || "None";

  providerSelect?.addEventListener("change", () => {
    const p = providerSelect.value;
    localStorage.setItem("ghostwriter:ai_provider", p);
    apiKeyInput.value = localStorage.getItem(`ghostwriter:key_${p}`) || "";
    modelsBrowser?.classList.add("hidden");
    allModels = [];
    updateModelIndicator();
  });

  apiKeyInput?.addEventListener("input", () => {
    const p = providerSelect.value;
    localStorage.setItem(`ghostwriter:key_${p}`, apiKeyInput.value.trim());
    // legacy compat for openrouter
    if (p === "openrouter") localStorage.setItem("ghostwriter:openrouter_key", apiKeyInput.value.trim());
    updateModelIndicator();
  });

  function renderModels() {
    if (!modelsList) return;
    modelsList.innerHTML = "";
    const query = modelSearch.value.toLowerCase();
    const filtered = allModels.filter(m =>
      m.id.toLowerCase().includes(query) || m.name.toLowerCase().includes(query)
    );
    if (!filtered.length) {
      modelsList.innerHTML = `<p style="font-size:13px;opacity:.6;padding:8px 0;">No models match.</p>`;
      return;
    }
    filtered.forEach(model => {
      const el = document.createElement("div");
      el.className = "model-result";
      el.style.cursor = "pointer";
      el.innerHTML = `<strong>${model.name}</strong><small>${model.id}</small>`;
      el.onclick = () => {
        localStorage.setItem("ghostwriter:openrouter_model", model.id);
        orModelDisplay.textContent = model.id;
        updateModelIndicator();
        toast(`Model selected: ${model.id}`, "success");
      };
      modelsList.appendChild(el);
    });
  }

  modelSearch?.addEventListener("input", renderModels);

  loadModelsBtn.onclick = async () => {
    const provider = providerSelect.value;
    const key = apiKeyInput.value.trim();
    if (!key) return toast("Masukkan API Key Anda terlebih dahulu", "error");

    loadModelsBtn.disabled = true;
    loadModelsBtn.textContent = "Memuat...";
    try {
      const fetcher = PROVIDER_MODEL_URLS[provider];
      if (!fetcher) throw new Error("Provider not supported");
      allModels = await fetcher(key);
      modelsBrowser?.classList.remove("hidden");
      renderModels();
      toast(`Berhasil memuat ${allModels.length} model`, "success");
    } catch (err) {
      toast(`Failed to load models: ${err.message}`, "error");
    } finally {
      loadModelsBtn.disabled = false;
      loadModelsBtn.textContent = "Muat";
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
    toast("Mengimpor data...");
    try {
      const formData = new FormData();
      formData.append("file", file);
      const headers = {};
      const token = localStorage.getItem("ghostwriter:session") || state.sessionToken;
      if (token) headers["Authorization"] = `Bearer ${token}`;

      const response = await fetch("/api/import", { method: "POST", headers, body: formData });
      if (!response.ok) throw await response.json().catch(() => ({message: `HTTP ${response.status}`}));
      toast("Impor berhasil! Memuat ulang...", "success");
      setTimeout(() => window.location.reload(), 1500);
    } catch (err) {
      toast("Failed to import file: " + err.message, "error");
    }
    e.target.value = "";
  };

  $("#learn-raw-button").onclick = learnRawWriting;
  $("#reference-button").onclick = searchReferences;

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
      await Promise.all([loadSyncStatus()]);
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

// Advanced UI Functions
window.editWorkspace = async function(id, oldName) {
  closeSheet();
  const newName = await showPrompt("Nama baru untuk workspace:", oldName);
  if (!newName || newName === oldName) return;
  try {
    const result = await jsonApi("/api/workspace/rename", {
      method: "POST",
      body: { workspace_id: id, name: newName }
    });
    if (result.status === "success") {
      await loadWorkspaces();
      if (id === state.workspace) {
        $("#workspace-name").textContent = newName;
      }
      toast("Workspace diubah namanya");
      showWorkspaceSheet();
    }
  } catch (err) {
    toast(err.message, "error");
  }
};

window.deleteWorkspace = async function(id) {
  closeSheet();
  if (!confirm("Hapus workspace ini beserta seluruh isinya secara permanen?")) return;
  try {
    const result = await jsonApi("/api/workspace/delete", {
      method: "POST",
      body: { workspace_id: id }
    });
    if (result.status === "success") {
      await loadWorkspaces();
      if (id === state.workspace) {
        await switchWorkspace("writing");
      }
      toast("Workspace dihapus");
    }
  } catch (err) {
    toast(err.message, "error");
  }
};

window.editBrainItem = async function(type, idOrContent, currentContent) {
  const newContent = await showPrompt("Edit konten:", currentContent || idOrContent);
  if (!newContent || newContent === (currentContent || idOrContent)) return;
  try {
    await jsonApi("/api/brain/item/update", {
      method: "POST",
      body: { workspace_id: state.workspace, type, id_or_content: idOrContent, new_content: newContent }
    });
    toast("Item diperbarui");
    await loadBrain();
  } catch (err) {
    toast(err.message, "error");
  }
};

window.deleteBrainItem = async function(type, idOrContent) {
  if (!confirm("Hapus item ini?")) return;
  try {
    await jsonApi("/api/brain/item/delete", {
      method: "POST",
      body: { workspace_id: state.workspace, type, id_or_content: idOrContent }
    });
    toast("Item dihapus");
    await loadBrain();
  } catch (err) {
    toast(err.message, "error");
  }
};

window.bulkApproveProposals = async function() {
  const ids = state.proposals.map(p => p.id);
  if (!ids.length) return;
  try {
    await jsonApi("/api/brain/proposals/bulk", {
      method: "POST",
      body: { workspace_id: state.workspace, action: "approve", proposal_ids: ids }
    });
    toast("Semua proposal disetujui");
    await loadProposals();
    await loadBrain();
  } catch (err) {
    toast(err.message, "error");
  }
};

window.bulkRejectProposals = async function() {
  const ids = state.proposals.map(p => p.id);
  if (!ids.length) return;
  try {
    await jsonApi("/api/brain/proposals/bulk", {
      method: "POST",
      body: { workspace_id: state.workspace, action: "reject", proposal_ids: ids }
    });
    toast("Semua proposal ditolak");
    await loadProposals();
    await loadBrain();
  } catch (err) {
    toast(err.message, "error");
  }
};
