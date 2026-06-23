// Migrate local storage keys from ghostwaiter:* to ghostwaiter:*
try {
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key && key.startsWith("ghostwaiter:")) {
      const newKey = key.replace("ghostwaiter:", "ghostwaiter:");
      if (localStorage.getItem(newKey) === null) {
        localStorage.setItem(newKey, localStorage.getItem(key));
      }
    }
  }
} catch (e) {
  console.error("Local storage migration error:", e);
}

const $ = selector => document.querySelector(selector);
let chatAbortController = null;
let generateAbortController = null;
const $$ = selector => [...document.querySelectorAll(selector)];

const state = {
  workspace: "personal",
  workspaces: [],
  currentChat: null,
  currentDraft: null,
  originalAiText: "",
  brain: null,
  proposals: [],
  brainTab: "style",
  saveTimer: null,
  deferredInstall: null,
  sessionToken: localStorage.getItem("ghostwaiter:session") || "",
  markdownBuffer: "",
  attachments: [],
  autoScrollActive: true,
  lastSentMessage: null,
  aiStatusTimer: null,
  notes: [],
  notesLayout: "grid",
  notesSelected: new Set(),
  notesSearch: "",
  notesActiveTag: "",
};

async function api(path, options = {}) {
  const config = {...options, credentials: "same-origin", headers: {...(options.headers || {})}};
  if (state.sessionToken) config.headers.Authorization = `Bearer ${state.sessionToken}`;
  
  const provider = localStorage.getItem("ghostwaiter:ai_provider") || "openrouter";
  const key = localStorage.getItem(`ghostwaiter:key_${provider}`) || localStorage.getItem("ghostwaiter:openrouter_key") || "";
  const model = localStorage.getItem("ghostwaiter:openrouter_model") || "";
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
  const provider = localStorage.getItem("ghostwaiter:ai_provider") || "openrouter";
  const key = localStorage.getItem(`ghostwaiter:key_${provider}`) || localStorage.getItem("ghostwaiter:openrouter_key") || "";
  const model = localStorage.getItem("ghostwaiter:openrouter_model") || "";
  const btn = $("#model-status");
  if (!btn) return;
  const icon = btn.querySelector("i");
  const label = btn.querySelector("span");
  if (key && model) {
    if (icon) { icon.style.background = "#22c55e"; icon.style.boxShadow = "0 0 6px #22c55e88"; }
    const shortModel = model.split("/").pop();
    if (label) label.textContent = shortModel.length > 16 ? shortModel.slice(0, 14) + "…" : shortModel;
    btn.title = `${provider}: ${model}`;
  } else {
    if (icon) { icon.style.background = ""; icon.style.boxShadow = ""; }
    if (label) label.textContent = "AI";
    btn.title = "Click to configure AI in Settings";
  }
}

async function syncAIConfigFromSupabase() {
  try {
    const config = await jsonApi("/api/ai/config");
    if (config && config.provider) {
      localStorage.setItem("ghostwaiter:ai_provider", config.provider);
      localStorage.setItem("ghostwaiter:openrouter_model", config.model || "");
      if (config.keys) {
        for (const [provider, key] of Object.entries(config.keys)) {
          if (key) {
            localStorage.setItem(`ghostwaiter:key_${provider}`, key);
            if (provider === "openrouter") {
              localStorage.setItem("ghostwaiter:openrouter_key", key);
            }
          }
        }
      }
      
      const providerSelect = $("#ai-provider-select");
      const apiKeyInput = $("#ai-api-key");
      const orModelDisplay = $("#active-model-display");
      if (providerSelect) providerSelect.value = config.provider;
      if (apiKeyInput) apiKeyInput.value = config.keys[config.provider] || "";
      if (orModelDisplay) orModelDisplay.textContent = config.model || "None";
      
      // Update custom select dropdown display
      const aiProviderDisplay = $("#ai-provider-display");
      const aiProviderMenu = $("#ai-provider-menu");
      if (aiProviderDisplay && config.provider) {
        const activeOption = aiProviderMenu?.querySelector(`.dropdown-item[data-value="${config.provider}"]`);
        if (activeOption) {
          aiProviderMenu.querySelectorAll(".dropdown-item").forEach(el => el.classList.remove("active"));
          activeOption.classList.add("active");
          aiProviderDisplay.textContent = activeOption.textContent;
        }
      }
      
      updateModelIndicator();
    }
  } catch (err) {
    console.error("Failed to sync AI config from Supabase:", err);
  }
}

async function saveAIConfigToSupabase() {
  const provider = localStorage.getItem("ghostwaiter:ai_provider") || "openrouter";
  const model = localStorage.getItem("ghostwaiter:openrouter_model") || "";
  const keys = {
    openrouter: localStorage.getItem("ghostwaiter:key_openrouter") || localStorage.getItem("ghostwaiter:openrouter_key") || "",
    google: localStorage.getItem("ghostwaiter:key_google") || "",
    groq: localStorage.getItem("ghostwaiter:key_groq") || "",
    deepseek: localStorage.getItem("ghostwaiter:key_deepseek") || "",
    mistral: localStorage.getItem("ghostwaiter:key_mistral") || "",
    kilo: localStorage.getItem("ghostwaiter:key_kilo") || "",
  };
  
  try {
    await api("/api/ai/config", {
      method: "POST",
      body: { provider, model, keys }
    });
  } catch (err) {
    console.error("Failed to save AI config to Supabase:", err);
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
      modal.removeEventListener("click", onBackdropClick);
    };
    const onOk = () => { cleanup(); resolve(true); };
    const onCancel = () => { cleanup(); resolve(false); };
    const onBackdropClick = (e) => {
      if (e.target === modal) {
        cleanup();
        resolve(false);
      }
    };
    $("#confirm-ok").addEventListener("click", onOk);
    $("#confirm-cancel").addEventListener("click", onCancel);
    modal.addEventListener("click", onBackdropClick);
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
      $("#prompt-cancel").removeEventListener("click", onCancelClick);
      modal.removeEventListener("click", onBackdropClick);
    };
    const onOk = () => { cleanup(); resolve(input.value); };
    const onCancelClick = async () => {
      if (input.value !== defaultValue) {
        if (await showConfirm("Discard unsaved changes?")) {
          cleanup();
          resolve(null);
        }
      } else {
        cleanup();
        resolve(null);
      }
    };
    const onBackdropClick = (e) => {
      if (e.target === modal) {
        onCancelClick();
      }
    };
    $("#prompt-ok").addEventListener("click", onOk);
    $("#prompt-cancel").addEventListener("click", onCancelClick);
    modal.addEventListener("click", onBackdropClick);
  });
}

function escapeHtml(value = "") {
  return String(value).replace(/[&<>"']/g, char => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"}[char]));
}

// Custom marked and code handlers
if (typeof marked !== 'undefined') {
  const renderer = new marked.Renderer();
  
  renderer.code = function(code, infostring) {
    const language = infostring || 'plaintext';
    const escapedCode = String(code).replace(/[&<>"']/g, char => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"}[char]));
    
    let highlighted = escapedCode;
    if (typeof hljs !== 'undefined') {
      try {
        const langObj = hljs.getLanguage(language);
        if (langObj) {
          highlighted = hljs.highlight(code, { language }).value;
        } else {
          highlighted = hljs.highlightAuto(code).value;
        }
      } catch (e) {}
    }
    
    return `
      <div class="code-block-container">
        <div class="code-block-header">
          <span class="code-block-lang">${language}</span>
          <div class="code-block-actions">
            <button class="code-block-action-btn wrap-btn" type="button" onclick="toggleCodeWrap(this)">Wrap</button>
            <button class="code-block-action-btn copy-btn" type="button" onclick="copyCodeText(this)">Copy Code</button>
          </div>
        </div>
        <pre class="language-${language}"><code class="language-${language}">${highlighted}</code></pre>
      </div>
    `;
  };
  
  renderer.table = function(header, body) {
    return `
      <div class="table-container">
        <table>
          <thead>${header}</thead>
          <tbody>${body}</tbody>
        </table>
      </div>
    `;
  };
  
  marked.use({ renderer });
}

window.copyCodeText = function(button) {
  const container = button.closest('.code-block-container');
  const code = container.querySelector('pre code').innerText;
  navigator.clipboard.writeText(code).then(() => {
    button.textContent = "Copied!";
    setTimeout(() => {
      button.textContent = "Copy Code";
    }, 2000);
  });
};

window.toggleCodeWrap = function(button) {
  const container = button.closest('.code-block-container');
  const pre = container.querySelector('pre');
  pre.classList.toggle('word-wrap');
  if (pre.classList.contains('word-wrap')) {
    button.textContent = "Unwrap";
  } else {
    button.textContent = "Wrap";
  }
};

function renderMarkdown(source = "") {
  source = source.replace(/<think>[\s\S]*?(<\/think>|$)/gi, '');
  if (typeof marked !== 'undefined') {
    return marked.parse(source);
  }
  return "<p>" + escapeHtml(source).replace(/\n/g, "<br>") + "</p>";
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
  localStorage.setItem("ghostwaiter:activeView", view);
  if (view === "brain") loadBrain();
  if (view === "notes") loadNotes();
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
  let sidebarState = localStorage.getItem("ghostwaiter:sidebar") || "expanded";
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

  const lastView = localStorage.getItem("ghostwaiter:activeView") || "chat";
  initNotesSystem();
  showView(lastView);
  await loadWorkspaces();
  if (lastView === "notes") loadNotes();
  await Promise.all([loadSyncStatus(), syncAIConfigFromSupabase()]);
  restoreLocalDraft();
  restoreChatDraft();
  updateModelIndicator();

  // Automatic sync logic (device baru atau sudah lama tidak dibuka)
  const lastOpenedStr = localStorage.getItem("ghostwaiter:last_opened");
  const now = Date.now();
  let shouldAutoSync = false;

  if (!lastOpenedStr) {
    shouldAutoSync = true; // Device baru
  } else {
    const lastOpened = parseInt(lastOpenedStr);
    const oneHour = 60 * 60 * 1000;
    if (now - lastOpened > oneHour) {
      shouldAutoSync = true; // Sudah lama tidak dibuka
    }
  }

  localStorage.setItem("ghostwaiter:last_opened", now.toString());

  // Update last_opened timestamp periodically to keep track of activity
  setInterval(() => {
    localStorage.setItem("ghostwaiter:last_opened", Date.now().toString());
  }, 60000);

  if (shouldAutoSync) {
    setTimeout(() => {
      performSync(true);
    }, 1500);
  }

  // Cek berkala (setiap 5 menit)
  setInterval(() => {
    performSync(true);
  }, 5 * 60 * 1000);

  if ("serviceWorker" in navigator) navigator.serviceWorker.register("/service-worker.js");
}

let theme = localStorage.getItem("ghostwaiter:theme") || "system";

function applyTheme() {
  const themeBtnSpan = $("#theme-button span:first-child");
  if (theme === "system") {
    document.documentElement.removeAttribute("data-theme");
    if ($("#theme-detail")) $("#theme-detail").textContent = "Auto";
    if (themeBtnSpan) {
      themeBtnSpan.innerHTML = `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2v2M4.93 4.93l1.41 1.41M2 12h2M6.34 17.66l-1.41 1.41M12 20v2"/><path d="M12 18A6 6 0 0 1 12 6"/><path d="M12 6a6 6 0 0 1 6 6 6 6 0 0 1-6 6a4.5 4.5 0 0 0 0-12z" fill="currentColor"/></svg>`;
    }
  } else if (theme === "dark") {
    document.documentElement.setAttribute("data-theme", "dark");
    if ($("#theme-detail")) $("#theme-detail").textContent = "Dark";
    if (themeBtnSpan) {
      themeBtnSpan.innerHTML = `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/></svg>`;
    }
  } else {
    document.documentElement.setAttribute("data-theme", "light");
    if ($("#theme-detail")) $("#theme-detail").textContent = "Light";
    if (themeBtnSpan) {
      themeBtnSpan.innerHTML = `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/></svg>`;
    }
  }
  localStorage.setItem("ghostwaiter:theme", theme);
}

window.toggleChatTitle = function() {
  const title = $("#chat-title");
  const btn = $("#toggle-title-btn");
  if (!title) return;
  title.classList.toggle("hidden");
  
  if (btn) {
    if (title.classList.contains("hidden")) {
      btn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="m6 9 6 6 6-6"/></svg>`;
    } else {
      btn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="m18 15-6-6-6 6"/></svg>`;
    }
  }
};

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
  localStorage.setItem("ghostwaiter:sidebar", isMinimized ? "minimized" : "expanded");
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
         ${item.id === 'personal' ? '' : `<button class="text-button danger" onclick="deleteWorkspace('${escapeHtml(item.id)}')" style="font-size:12px; padding:4px 8px; color:var(--error);">Delete</button>`}
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
  if (localStorage.getItem("ghostwaiter:activeView") === "notes") {
    loadNotes();
  }
  toast("Workspace changed");
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

// Attachment state and handlers
async function handleAttachmentSelect(event) {
  const files = Array.from(event.target.files);
  const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5MB limit
  for (const file of files) {
    if (file.size > MAX_FILE_SIZE) {
      toast(`File ${file.name} is too large (max 5MB)`, "error");
      continue;
    }
    if (state.attachments.some(a => a.name === file.name && a.size === file.size)) continue;
    
    const attachment = {
      name: file.name,
      size: file.size,
      type: file.type,
      content: ""
    };
    
    try {
      if (file.type.startsWith("image/")) {
        attachment.content = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = (e) => resolve(e.target.result);
          reader.onerror = (e) => reject(new Error("Failed to read image"));
          reader.readAsDataURL(file);
        });
      } else {
        attachment.content = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = (e) => resolve(e.target.result);
          reader.onerror = (e) => reject(new Error("Failed to read file"));
          reader.readAsText(file);
        });
      }
      state.attachments.push(attachment);
    } catch (err) {
      toast(err.message, "error");
    }
  }
  
  event.target.value = ""; // Reset file input
  renderAttachmentPreviews();
  saveChatDraft();
}

function renderAttachmentPreviews() {
  const container = $("#attachment-previews");
  if (!container) return;
  
  if (state.attachments.length === 0) {
    container.classList.add("hidden");
    container.innerHTML = "";
    return;
  }
  
  container.classList.remove("hidden");
  container.innerHTML = state.attachments.map((att, idx) => {
    if (att.type.startsWith("image/")) {
      return `
        <div class="attachment-preview-card image-preview" data-idx="${idx}">
          <img src="${att.content}" alt="${escapeHtml(att.name)}">
          <button class="remove-attachment-btn" type="button" aria-label="Remove attachment" onclick="removeAttachment(${idx})">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </div>
      `;
    } else {
      const sizeStr = (att.size / 1024).toFixed(1) + " KB";
      const fileExt = att.name.split('.').pop().toUpperCase();
      return `
        <div class="attachment-preview-card file-preview" data-idx="${idx}">
          <div class="file-icon-badge">${fileExt}</div>
          <div class="file-details">
            <span class="file-name" title="${escapeHtml(att.name)}">${escapeHtml(att.name)}</span>
            <span class="file-meta">${sizeStr}</span>
          </div>
          <button class="remove-attachment-btn" type="button" aria-label="Remove attachment" onclick="removeAttachment(${idx})">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </div>
      `;
    }
  }).join("");
}

window.removeAttachment = function(idx) {
  state.attachments.splice(idx, 1);
  renderAttachmentPreviews();
  saveChatDraft();
};

// Draft saving functions
function saveChatDraft() {
  const text = $("#chat-input")?.value || "";
  const draftKey = `ghostwaiter:chat_draft:${state.currentChat || "new"}`;
  localStorage.setItem(draftKey, JSON.stringify({
    text: text,
    attachments: state.attachments
  }));
}

function restoreChatDraft() {
  const draftKey = `ghostwaiter:chat_draft:${state.currentChat || "new"}`;
  const saved = localStorage.getItem(draftKey);
  const container = $("#attachment-previews");
  if (!saved) {
    state.attachments = [];
    if ($("#chat-input")) $("#chat-input").value = "";
    if (container) {
      container.classList.add("hidden");
      container.innerHTML = "";
    }
    autoResizeChatInput();
    return;
  }
  try {
    const data = JSON.parse(saved);
    state.attachments = data.attachments || [];
    if ($("#chat-input")) $("#chat-input").value = data.text || "";
    renderAttachmentPreviews();
    autoResizeChatInput();
  } catch (e) {
    state.attachments = [];
    if ($("#chat-input")) $("#chat-input").value = "";
  }
}

function clearChatDraft() {
  const draftKey = `ghostwaiter:chat_draft:${state.currentChat || "new"}`;
  localStorage.removeItem(draftKey);
  state.attachments = [];
  renderAttachmentPreviews();
}

// AI Activity Status management
function updateAiStatus(status) {
  const container = $("#ai-status-container");
  const text = $("#ai-status-text");
  if (!container || !text) return;
  
  if (!status) {
    container.classList.add("hidden");
    return;
  }
  
  text.textContent = status;
  container.classList.remove("hidden");
}

function setAiStatusWithTransitions(hasImages, hasFiles) {
  clearTimeout(state.aiStatusTimer);
  
  let initial = "Preparing response...";
  if (hasImages) initial = "Processing uploaded image...";
  else if (hasFiles) initial = "Reading attached file...";
  
  updateAiStatus(initial);
  
  state.aiStatusTimer = setTimeout(() => {
    updateAiStatus("Retrieving context...");
    state.aiStatusTimer = setTimeout(() => {
      updateAiStatus("Searching knowledge sources...");
    }, 1200);
  }, 1000);
}

function clearAiStatus() {
  clearTimeout(state.aiStatusTimer);
  updateAiStatus("Finalizing response...");
  setTimeout(() => updateAiStatus(null), 500);
}

// Auto scroll management
function scrollToBottom(smooth = true) {
  const msgs = $("#chat-messages");
  if (!msgs) return;
  msgs.scrollTo({
    top: msgs.scrollHeight,
    behavior: smooth ? "smooth" : "auto"
  });
}

function initScrollSystem() {
  const msgs = $("#chat-messages");
  const scrollBtn = $("#scroll-bottom-btn");
  if (!msgs || !scrollBtn) return;
  
  msgs.addEventListener("scroll", () => {
    // Check if user is near the bottom
    const isAtBottom = msgs.scrollTop + msgs.clientHeight >= msgs.scrollHeight - 30;
    state.autoScrollActive = isAtBottom;
    
    if (isAtBottom) {
      scrollBtn.classList.add("hidden");
    } else {
      scrollBtn.classList.remove("hidden");
    }
  });
  
  scrollBtn.onclick = () => {
    scrollToBottom(true);
  };
}

// Custom copy handlers and rendering
window.copyMessageText = function(button) {
  const wrapperNode = button.closest('.message-wrapper');
  const text = wrapperNode.querySelector('.msg-content').innerText;
  navigator.clipboard.writeText(text).then(() => {
    toast('Message copied', 'success');
  });
};

function appendMessage(role, content = "", attachments = null) {
  const messages = $("#chat-messages");
  if (messages.querySelector(".empty-state")) messages.innerHTML = "";
  
  const node = document.createElement("div");
  node.className = `message-wrapper ${role}`;
  
  let attachmentsHtml = "";
  if (attachments && attachments.length > 0) {
    attachmentsHtml = `<div class="message-attachments">` + attachments.map(att => {
      if (att.type.startsWith("image/")) {
        return `<div class="msg-attachment-card image-card"><img src="${att.content}" alt="${escapeHtml(att.name)}" onclick="openImageModal('${att.content}')"></div>`;
      } else {
        const sizeStr = (att.size / 1024).toFixed(1) + " KB";
        const fileExt = att.name.split('.').pop().toUpperCase();
        return `
          <div class="msg-attachment-card file-card">
            <div class="file-badge">${fileExt}</div>
            <div class="file-info">
              <span class="file-title" title="${escapeHtml(att.name)}">${escapeHtml(att.name)}</span>
              <span class="file-size">${sizeStr}</span>
            </div>
          </div>
        `;
      }
    }).join("") + `</div>`;
  }
  
  if (role === "assistant") {
    node.innerHTML = `
      <div class="message assistant">
        <div class="msg-content">${renderMarkdown(content)}</div>
        ${attachmentsHtml}
      </div>
      <div class="message-actions">
        <button class="message-action-btn copy-btn" type="button" onclick="copyMessageText(this)">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
          Copy
        </button>
      </div>
    `;
  } else {
    node.innerHTML = `
      <div class="message user">
        <div class="msg-content"></div>
        ${attachmentsHtml}
      </div>
      <div class="message-actions">
        <button class="message-action-btn copy-btn" type="button" onclick="copyMessageText(this)">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
          Copy
        </button>
      </div>
    `;
    node.querySelector('.msg-content').innerHTML = linkify(escapeHtml(content));
  }
  
  messages.appendChild(node);
  
  if (state.autoScrollActive) {
    scrollToBottom(true);
  }
  return node;
}

window.openImageModal = function(src) {
  const modal = document.createElement("div");
  modal.className = "image-lightbox-modal";
  modal.innerHTML = `
    <div class="lightbox-backdrop" onclick="this.parentNode.remove()"></div>
    <div class="lightbox-content">
      <img src="${src}" alt="Attached Image">
      <button class="lightbox-close-btn" onclick="this.parentNode.parentNode.remove()">&times;</button>
    </div>
  `;
  document.body.appendChild(modal);
};

// Send and Retry operations
async function sendChat(event) {
  if (event) event.preventDefault();
  
  const input = $("#chat-input");
  const message = input.value.trim();
  
  if (chatAbortController) {
    chatAbortController.abort();
    return;
  }
  
  if (!message && state.attachments.length === 0) return;
  
  // Hide error container
  const errorContainer = $("#chat-error-container");
  if (errorContainer) errorContainer.classList.add("hidden");
  
  // Save message details for retry
  state.lastSentMessage = {
    message,
    attachments: [...state.attachments]
  };
  
  // Add user message to display
  appendMessage("user", message, state.attachments);
  
  // Clear input composer and draft
  input.value = "";
  clearChatDraft();
  autoResizeChatInput();
  
  // Update Send button to Stop
  const sendBtn = $("#chat-send");
  sendBtn.classList.add("stop-mode");
  sendBtn.innerHTML = '<svg id="stop-icon" width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>';
  sendBtn.setAttribute("aria-label", "Stop");
  
  // Show status area and set status
  const hasImages = state.lastSentMessage.attachments.some(a => a.type.startsWith("image/"));
  const hasFiles = state.lastSentMessage.attachments.some(a => !a.type.startsWith("image/"));
  setAiStatusWithTransitions(hasImages, hasFiles);
  
  const assistant = appendMessage("assistant", "");
  assistant.querySelector('.message').classList.add("generating");
  
  let fullResponse = "";
  chatAbortController = new AbortController();
  
  try {
    // Format attachments payload
    const attachmentsPayload = state.lastSentMessage.attachments.map(att => {
      let cleanContent = att.content;
      if (att.type.startsWith("image/") && cleanContent.includes("base64,")) {
        cleanContent = cleanContent.split("base64,").pop();
      }
      return {
        name: att.name,
        size: att.size,
        type: att.type,
        content: cleanContent
      };
    });
    
    const response = await api("/api/chat/send", {
      method: "POST",
      body: {
        workspace_id: state.workspace,
        chat_id: state.currentChat,
        message,
        attachments: attachmentsPayload.length > 0 ? attachmentsPayload : null
      },
      signal: chatAbortController.signal,
    });
    
    state.currentChat = response.headers.get("X-Chat-Id");
    if ($("#chat-title").textContent === "New Chat" || $("#chat-title").textContent === "Chat Baru") {
      $("#chat-title").textContent = message ? message.slice(0, 60) : "Image/File Chat";
    }
    
    // Clear status timer and set generating
    clearTimeout(state.aiStatusTimer);
    updateAiStatus("Generating response...");
    
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let chunkCount = 0;
    
    while (true) {
      const {value, done} = await reader.read();
      if (done) break;
      
      chunkCount++;
      if (chunkCount === 50) {
        updateAiStatus("Formatting answer...");
      }
      
      fullResponse += decoder.decode(value, {stream: true});
      assistant.querySelector(".msg-content").innerHTML = renderMarkdown(fullResponse);
      
      if (state.autoScrollActive) {
        scrollToBottom(true);
      }
    }
    
    assistant.querySelector('.message').classList.remove("generating");
    clearAiStatus();
  } catch (error) {
    assistant.remove(); // Remove empty/failed assistant bubble
    
    if (error.name === "AbortError") {
      toast("Cancelled");
      clearAiStatus();
    } else {
      clearAiStatus();
      // Show professional error card instead of polluting history
      if (errorContainer) {
        $("#chat-error-text").textContent = error.message || "Failed to generate response.";
        errorContainer.classList.remove("hidden");
        scrollToBottom(true);
      }
      
      // Restore the draft text so it's not lost
      input.value = message;
      state.attachments = state.lastSentMessage.attachments;
      renderAttachmentPreviews();
      autoResizeChatInput();
    }
  } finally {
    chatAbortController = null;
    sendBtn.classList.remove("stop-mode");
    sendBtn.innerHTML = '<svg id="send-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5M5 12l7-7 7 7"/></svg>';
    sendBtn.setAttribute("aria-label", "Send");
    
    // Retrieve proposals background task
    setTimeout(async () => {
      const previous = state.brain?.pending_proposals || 0;
      try {
        const profile = await jsonApi(`/api/brain/profile?workspace_id=${encodeURIComponent(state.workspace)}`);
        state.brain = profile;
        $("#proposal-count").textContent = profile.pending_proposals ? `(${profile.pending_proposals})` : "";
        if (profile.pending_proposals > previous) toast("New learning proposal available for review");
      } catch (_) {}
    }, 4500);
  }
}

window.retrySendChat = function() {
  if (!state.lastSentMessage) return;
  
  // Hide error container
  const errorContainer = $("#chat-error-container");
  if (errorContainer) errorContainer.classList.add("hidden");
  
  // Delete the last user message from UI since sendChat will append it again
  const messages = $("#chat-messages");
  const wrappers = messages.querySelectorAll(".message-wrapper");
  if (wrappers.length > 0) {
    const lastWrapper = wrappers[wrappers.length - 1];
    if (lastWrapper.classList.contains("user")) {
      lastWrapper.remove();
    }
  }
  
  // Set input values to last sent values and trigger sendChat
  $("#chat-input").value = state.lastSentMessage.message;
  state.attachments = state.lastSentMessage.attachments;
  
  sendChat();
};

function resetChat() {
  state.currentChat = null;
  $("#chat-title").textContent = "New Chat";
  $("#chat-messages").innerHTML = `<div class="empty-state"><strong>Start with an idea.</strong><span>Discuss concepts, structure arguments, or ask for feedback.</span></div>`;
  
  // Hide error and status
  const errorContainer = $("#chat-error-container");
  if (errorContainer) errorContainer.classList.add("hidden");
  updateAiStatus(null);
  
  clearChatDraft();
  restoreChatDraft();
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
      <button class="sheet-option ${archived ? "" : "chat-option"} ${item.id === state.currentChat ? "active" : ""}" data-id="${escapeHtml(item.id)}" type="button">
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
  toast("Chat restored");
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
  
  // Hide error and status
  const errorContainer = $("#chat-error-container");
  if (errorContainer) errorContainer.classList.add("hidden");
  updateAiStatus(null);
  
  chat.messages.forEach(message => appendMessage(message.role, message.content, message.attachments));
  closeSheet();
  
  restoreChatDraft();
}

async function generateWriting() {
  if (generateAbortController) {
    generateAbortController.abort();
    return;
  }
  const prompt = $("#write-prompt").value.trim();
  if (!prompt) return toast("Write instructions first");
  const button = $("#generate-button");
  button.textContent = "Stop";
  $("#draft-content").value = "";
  state.originalAiText = "";
  
  generateAbortController = new AbortController();

  try {
    const activeModeNode = document.querySelector("#write-mode-menu .dropdown-item.active");
    const mode = activeModeNode ? activeModeNode.dataset.mode : "write";
    const response = await api("/api/ai/generate", {
      method: "POST",
      body: {workspace_id: state.workspace, prompt, mode},
      signal: generateAbortController.signal,
    });
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let fullChunk = "";
    while (true) {
      const {value, done} = await reader.read();
      if (done) break;
      let chunk = decoder.decode(value, {stream: true});
      fullChunk += chunk;
      
      // Strip <think> blocks completely
      let displayChunk = fullChunk.replace(/<think>[\s\S]*?(<\/think>|$)/gi, '');
      displayChunk = displayChunk.replace(/[*#_\[\]`]/g, ""); // Strip markdown
      
      $("#draft-content").value = displayChunk;
      $("#draft-content").scrollTop = $("#draft-content").scrollHeight;
    }
    state.originalAiText = $("#draft-content").value;
    scheduleDraftSave();
    saveUndoState();
    updateWordCount();
  } catch (error) {
    if (error.name === "AbortError") {
      toast("Cancelled");
    } else if (error.message.includes("All inference models failed") || error.message.includes("Semua model inference gagal")) {
      toast("AI network busy, please try again later");
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
  return `ghostwaiter:draft:${state.workspace}`;
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
    $("#save-state").textContent = "Restored from device";
  } catch (_) {}
  
  undoStack.length = 0;
  undoIndex = -1;
  saveUndoState();
  updateWordCount();
}

function scheduleDraftSave() {
  saveDraftLocally();
  $("#save-state").textContent = navigator.onLine ? "Saving..." : "Saved offline";
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
    $("#save-state").textContent = "Saved";
    loadSyncStatus();
  } catch (error) {
    $("#save-state").textContent = "Saved offline";
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
  $("#save-state").textContent = "Saved";
  saveDraftLocally();
  closeSheet();
}

async function trainRevision() {
  const revised = $("#draft-content").value.trim();
  if (!state.originalAiText || !revised) return toast("Generate writing then edit before Training");
  if (revised === state.originalAiText.trim()) return toast("No revisions to learn");
  const button = $("#train-button");
  button.disabled = true;
  button.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="margin-right:6px;"><path d="M22 10v6M2 10l10-5 10 5-10 5z"/><path d="M6 12v5c0 2 2 3 6 3s6-1 6-3v-5"/></svg> Mempelajari...`;
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
    button.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="margin-right:6px;"><path d="M22 10v6M2 10l10-5 10 5-10 5z"/><path d="M6 12v5c0 2 2 3 6 3s6-1 6-3v-5"/></svg> Train`;
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
  const bulkActions = $("#proposal-bulk-actions");
  if (bulkActions) bulkActions.style.display = state.brainTab === "proposals" && state.proposals?.length ? "flex" : "none";
  
  const list = $("#brain-list");
  if (state.brainTab === "style") {
    const items = state.brain.style_profile.rules || [];
    list.innerHTML = items.length ? items.map(item => `
      <article class="insight-card">
        <p>${escapeHtml(item)}</p>
        <div class="insight-meta" style="display:flex; gap:12px; margin-top:8px;">
          <button class="text-button compact" onclick="editBrainItem('style', '${escapeHtml(item).replace(/'/g, "\\'")}', '${escapeHtml(item).replace(/'/g, "\\'")}')">Edit</button>
          <button class="text-button compact danger" onclick="deleteBrainItem('style', '${escapeHtml(item).replace(/'/g, "\\'")}')">Delete</button>
        </div>
      </article>`).join("") : `<div class="empty-state" style="min-height:240px"><strong>Belum ada pola.</strong><span>Latih revisi atau sediakan sampel tulisan.</span></div>`;
  } else if (state.brainTab === "thinking") {
    const items = state.brain.thinking_profile.patterns || [];
    list.innerHTML = items.length ? items.map(item => `
      <article class="insight-card">
        <p>${escapeHtml(item)}</p>
        <div class="insight-meta" style="display:flex; gap:12px; margin-top:8px;">
          <button class="text-button compact" onclick="editBrainItem('thinking', '${escapeHtml(item).replace(/'/g, "\\'")}', '${escapeHtml(item).replace(/'/g, "\\'")}')">Edit</button>
          <button class="text-button compact danger" onclick="deleteBrainItem('thinking', '${escapeHtml(item).replace(/'/g, "\\'")}')">Delete</button>
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
          <button class="text-button compact danger" onclick="deleteBrainItem('memory', '${escapeHtml(item.id)}')">Delete</button>
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
          <button class="button mini-button reject-proposal" type="button">Reject</button>
          <button class="button primary approve-proposal" type="button">Approve</button>
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
  if (!content) return toast("Enter writing sample");
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
  if (!original || !edited) return toast("Fill in original and edited text");
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
  button.textContent = "Saving...";
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
    toast("Pattern successfully learned", "success");
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

async function performSync(isAuto = false) {
  const btn = $("#sync-status");
  if (!btn) return;
  if (btn.classList.contains("syncing")) return;

  btn.className = "sync-button syncing";
  btn.title = "Syncing with GitHub...";

  try {
    const res = await jsonApi("/api/sync/run", { method: "POST" });
    btn.className = "sync-button success-anim online";
    btn.title = res.detail || "Synced successfully";
    
    setTimeout(() => {
      btn.className = "sync-button idle online";
      btn.title = "Connected to Supabase & Synced";
    }, 2000);
    
    if (res.status === "pulled") {
      setTimeout(() => {
        location.reload();
      }, 1500);
    }
  } catch (error) {
    console.error("Sync error:", error);
    btn.className = "sync-button failure-anim offline";
    btn.title = "Sync failed: " + error.message;
    
    setTimeout(() => {
      btn.className = "sync-button idle offline";
      btn.title = "Offline - Sync failed";
    }, 2000);
  }
}

async function loadSyncStatus() {
  try {
    const data = await jsonApi("/api/sync/status");
    const pill = $("#sync-status");
    if (!pill) return;
    
    if (pill.classList.contains("syncing") || pill.classList.contains("success-anim") || pill.classList.contains("failure-anim")) {
      return;
    }
    
    if (!data.supabase_configured) {
      pill.className = "sync-button idle offline";
      pill.title = "Supabase is not configured — check your environment settings";
    } else if (!data.supabase_connected) {
      pill.className = "sync-button idle offline";
      pill.title = "Offline — failed to connect to Supabase database";
    } else {
      pill.className = "sync-button idle online";
      pill.title = "Connected to Supabase & Synced";
    }
  } catch (_) {}
}

function bindEvents() {
  if ($("#model-status")) $("#model-status").onclick = () => { const provider = localStorage.getItem("ghostwaiter:ai_provider") || "openrouter"; const m = localStorage.getItem("ghostwaiter:openrouter_model"); const k = localStorage.getItem(`ghostwaiter:key_${provider}`) || localStorage.getItem("ghostwaiter:openrouter_key"); toast(m && k ? `${provider.toUpperCase()} · ${m}` : "AI not configured — open Settings → AI Provider", m && k ? "success" : "error"); };
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
      if (el.id === "chat-input" && !isLikelyDesktop) {
        // Allow mobile enter to pass through and create a newline
      } else {
        e.preventDefault();
        if (el.id === "chat-input") el.closest("form")?.requestSubmit();
        else if (el.id === "write-prompt") $("#generate-button")?.click();
        else if (el.id === "raw-writing") $("#learn-raw-button")?.click();
        else if (el.id === "compare-original" || el.id === "compare-edited") $("#compare-button")?.click();
        else if (el.id === "reference-query") $("#reference-button")?.click();
        return;
      }
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

  // ── Sidebar toggle (mobile backdrop blocks all background interaction) ─
  $$(".nav-item").forEach(button => button.onclick = () => { showView(button.dataset.view); if (window.innerWidth <= 780) toggleSidebar(); });
  if ($("#sidebar-toggle")) $("#sidebar-toggle").onclick = toggleSidebar;
  if ($("#mobile-sidebar-toggle")) $("#mobile-sidebar-toggle").onclick = toggleSidebar;
  if ($("#sidebar-backdrop")) {
    $("#sidebar-backdrop").onclick = (e) => {
      // Close sidebar only; stop event from reaching any element behind backdrop
      e.stopPropagation();
      e.preventDefault();
      toggleSidebar();
    };
  }
  if ($("#theme-button")) $("#theme-button").onclick = cycleTheme;
  
  const writeDropdownTrigger = $("#write-mode-trigger");
  const writeDropdownMenu = $("#write-mode-menu");
  const writeModeDisplay = $("#write-mode-display");
  
  if (writeDropdownTrigger && writeDropdownMenu) {
    writeDropdownTrigger.onclick = (e) => {
      e.stopPropagation();
      writeDropdownMenu.classList.toggle("hidden");
    };
    
    $$("#write-mode-menu .dropdown-item").forEach(item => {
      item.onclick = (e) => {
        e.stopPropagation();
        $$("#write-mode-menu .dropdown-item").forEach(i => i.classList.remove("active"));
        item.classList.add("active");
        writeModeDisplay.textContent = item.textContent;
        writeDropdownMenu.classList.add("hidden");
      };
    });
    
    document.addEventListener("click", () => {
      writeDropdownMenu.classList.add("hidden");
    });
  }

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
  const savedProvider = localStorage.getItem("ghostwaiter:ai_provider") || "openrouter";
  const savedKey      = localStorage.getItem(`ghostwaiter:key_${savedProvider}`) || "";
  const savedModel    = localStorage.getItem("ghostwaiter:openrouter_model") || "";
  if (providerSelect) providerSelect.value = savedProvider;
  if (apiKeyInput)    apiKeyInput.value    = savedKey;
  if (orModelDisplay) orModelDisplay.textContent = savedModel || "None";

  // Update custom select dropdown display
  const aiProviderDisplay = $("#ai-provider-display");
  const aiProviderMenu = $("#ai-provider-menu");
  if (aiProviderDisplay && savedProvider) {
    const activeOption = aiProviderMenu?.querySelector(`.dropdown-item[data-value="${savedProvider}"]`);
    if (activeOption) {
      aiProviderMenu.querySelectorAll(".dropdown-item").forEach(el => el.classList.remove("active"));
      activeOption.classList.add("active");
      aiProviderDisplay.textContent = activeOption.textContent;
    }
  }

  // Custom Dropdown Trigger and Option events
  const aiProviderTrigger = $("#ai-provider-trigger");
  if (aiProviderTrigger && aiProviderMenu) {
    aiProviderTrigger.onclick = (e) => {
      e.stopPropagation();
      aiProviderMenu.classList.toggle("hidden");
    };

    document.addEventListener("click", (e) => {
      if (!aiProviderTrigger.contains(e.target) && !aiProviderMenu.contains(e.target)) {
        aiProviderMenu.classList.add("hidden");
      }
    });

    aiProviderMenu.querySelectorAll(".dropdown-item").forEach(item => {
      item.onclick = (e) => {
        e.stopPropagation();
        aiProviderMenu.querySelectorAll(".dropdown-item").forEach(el => el.classList.remove("active"));
        item.classList.add("active");
        if (aiProviderDisplay) aiProviderDisplay.textContent = item.textContent;
        aiProviderMenu.classList.add("hidden");

        if (providerSelect) {
          providerSelect.value = item.dataset.value;
          providerSelect.dispatchEvent(new Event("change"));
        }
      };
    });
  }

  providerSelect?.addEventListener("change", () => {
    const p = providerSelect.value;
    localStorage.setItem("ghostwaiter:ai_provider", p);
    apiKeyInput.value = localStorage.getItem(`ghostwaiter:key_${p}`) || "";
    modelsBrowser?.classList.add("hidden");
    allModels = [];
    updateModelIndicator();
    saveAIConfigToSupabase();
  });

  apiKeyInput?.addEventListener("input", () => {
    const p = providerSelect.value;
    localStorage.setItem(`ghostwaiter:key_${p}`, apiKeyInput.value.trim());
    if (p === "openrouter") localStorage.setItem("ghostwaiter:openrouter_key", apiKeyInput.value.trim());
    updateModelIndicator();
  });

  apiKeyInput?.addEventListener("change", () => {
    saveAIConfigToSupabase();
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
        localStorage.setItem("ghostwaiter:openrouter_model", model.id);
        orModelDisplay.textContent = model.id;
        updateModelIndicator();
        toast(`Model selected: ${model.id}`, "success");
        saveAIConfigToSupabase();
      };
      modelsList.appendChild(el);
    });
  }

  modelSearch?.addEventListener("input", renderModels);

  loadModelsBtn.onclick = async () => {
    const provider = providerSelect.value;
    const key = apiKeyInput.value.trim();
    if (!key) return toast("Enter your API Key first", "error");

    loadModelsBtn.disabled = true;
    loadModelsBtn.textContent = "Memuat...";
    try {
      const fetcher = PROVIDER_MODEL_URLS[provider];
      if (!fetcher) throw new Error("Provider not supported");
      allModels = await fetcher(key);
      modelsBrowser?.classList.remove("hidden");
      renderModels();
      toast(`Successfully loaded ${allModels.length} models`, "success");
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

  // Scroll system setup
  initScrollSystem();

  // Attachment upload triggers
  const attachButton = $("#attach-button");
  const attachmentInput = $("#attachment-input");
  const attachMenu = $("#attach-menu");
  const attachImageBtn = $("#attach-image-btn");
  const attachDocBtn = $("#attach-doc-btn");

  if (attachButton && attachmentInput && attachMenu) {
    attachButton.onclick = (e) => {
      e.stopPropagation();
      attachMenu.classList.toggle("hidden");
    };

    if (attachImageBtn) {
      attachImageBtn.onclick = (e) => {
        e.stopPropagation();
        attachMenu.classList.add("hidden");
        attachmentInput.accept = "image/*";
        attachmentInput.click();
      };
    }

    if (attachDocBtn) {
      attachDocBtn.onclick = (e) => {
        e.stopPropagation();
        attachMenu.classList.add("hidden");
        attachmentInput.accept = "text/*,application/pdf,application/json,application/javascript,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
        attachmentInput.click();
      };
    }

    attachmentInput.onchange = handleAttachmentSelect;

    // Close menu when clicking outside
    document.addEventListener("click", (e) => {
      if (!attachMenu.contains(e.target) && e.target !== attachButton && !attachButton.contains(e.target)) {
        attachMenu.classList.add("hidden");
      }
    });

    // Close menu on Escape key
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        attachMenu.classList.add("hidden");
      }
    });
  }

  // Error retry trigger
  const retryBtn = $("#chat-retry-btn");
  if (retryBtn) {
    retryBtn.onclick = () => retrySendChat();
  }

  // Chat input resize & save draft
  const chatInput = $("#chat-input");
  if (chatInput) {
    window.autoResizeChatInput = function() {
      chatInput.style.height = "auto";
      const scrollHeight = chatInput.scrollHeight;
      const maxHeight = 180; // approx 8 lines
      if (scrollHeight > maxHeight) {
        chatInput.style.height = maxHeight + "px";
        chatInput.style.overflowY = "auto";
      } else {
        chatInput.style.height = scrollHeight + "px";
        chatInput.style.overflowY = "hidden";
      }
    };
    
    chatInput.addEventListener("input", () => {
      autoResizeChatInput();
      saveChatDraft();
      
      // Show/hide empty state
      const msgs = $("#chat-messages");
      if (!msgs) return;
      const isEmpty = chatInput.value.trim() === "";
      const hasMessages = msgs.querySelector(".message-wrapper");
      const emptyState = msgs.querySelector(".empty-state");
      if (!hasMessages) {
        if (!isEmpty && emptyState) {
          emptyState.style.display = "none";
        } else if (isEmpty && emptyState) {
          emptyState.style.display = "";
        }
      }
    });
  }

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
  
  if ($("#manage-data-button")) $("#manage-data-button").onclick = () => $("#data-modal").classList.remove("hidden");
  if ($("#modal-import-btn")) $("#modal-import-btn").onclick = () => { $("#import-file").click(); $("#data-modal").classList.add("hidden"); };
  if ($("#data-cancel")) $("#data-cancel").onclick = () => $("#data-modal").classList.add("hidden");
  
  let initialProvider = "";
  let initialKeys = {};
  let initialModel = "";

  const hasAIChanges = () => {
    const currentProvider = localStorage.getItem("ghostwaiter:ai_provider") || "openrouter";
    const currentModel = localStorage.getItem("ghostwaiter:openrouter_model") || "";
    if (currentProvider !== initialProvider || currentModel !== initialModel) return true;
    for (const p of ["openrouter", "google", "groq", "deepseek", "mistral", "kilo"]) {
      const currentKey = localStorage.getItem(`ghostwaiter:key_${p}`) || (p === "openrouter" ? localStorage.getItem("ghostwaiter:openrouter_key") : "") || "";
      const initialKey = initialKeys[p] || "";
      if (currentKey !== initialKey) return true;
    }
    return false;
  };

  const closeAIModalWithCheck = async () => {
    if (hasAIChanges()) {
      if (await showConfirm("Discard unsaved AI settings changes?")) {
        // Restore initial values
        localStorage.setItem("ghostwaiter:ai_provider", initialProvider);
        localStorage.setItem("ghostwaiter:openrouter_model", initialModel);
        for (const [p, val] of Object.entries(initialKeys)) {
          localStorage.setItem(`ghostwaiter:key_${p}`, val);
          if (p === "openrouter") localStorage.setItem("ghostwaiter:openrouter_key", val);
        }
        
        // Update input views
        const providerSelect = $("#ai-provider-select");
        const apiKeyInput = $("#ai-api-key");
        const orModelDisplay = $("#active-model-display");
        if (providerSelect) providerSelect.value = initialProvider;
        if (apiKeyInput) apiKeyInput.value = initialKeys[initialProvider] || "";
        if (orModelDisplay) orModelDisplay.textContent = initialModel || "None";
        
        const aiProviderDisplay = $("#ai-provider-display");
        const aiProviderMenu = $("#ai-provider-menu");
        if (aiProviderDisplay && initialProvider) {
          const activeOption = aiProviderMenu?.querySelector(`.dropdown-item[data-value="${initialProvider}"]`);
          if (activeOption) {
            aiProviderMenu.querySelectorAll(".dropdown-item").forEach(el => el.classList.remove("active"));
            activeOption.classList.add("active");
            aiProviderDisplay.textContent = activeOption.textContent;
          }
        }
        
        updateModelIndicator();
        saveAIConfigToSupabase();
        $("#ai-modal").classList.add("hidden");
      }
    } else {
      $("#ai-modal").classList.add("hidden");
    }
  };

  if ($("#ai-settings-button")) $("#ai-settings-button").onclick = () => {
    initialProvider = localStorage.getItem("ghostwaiter:ai_provider") || "openrouter";
    initialModel = localStorage.getItem("ghostwaiter:openrouter_model") || "";
    initialKeys = {
      openrouter: localStorage.getItem("ghostwaiter:key_openrouter") || localStorage.getItem("ghostwaiter:openrouter_key") || "",
      google: localStorage.getItem("ghostwaiter:key_google") || "",
      groq: localStorage.getItem("ghostwaiter:key_groq") || "",
      deepseek: localStorage.getItem("ghostwaiter:key_deepseek") || "",
      mistral: localStorage.getItem("ghostwaiter:key_mistral") || "",
      kilo: localStorage.getItem("ghostwaiter:key_kilo") || "",
    };
    $("#ai-modal").classList.remove("hidden");
  };

  if ($("#ai-settings-close")) $("#ai-settings-close").onclick = closeAIModalWithCheck;

  // Backdrop click-outside-to-close handlers
  const dataModal = $("#data-modal");
  if (dataModal) {
    dataModal.onclick = (e) => {
      if (e.target === dataModal) {
        dataModal.classList.add("hidden");
      }
    };
  }
  const aiModal = $("#ai-modal");
  if (aiModal) {
    aiModal.onclick = (e) => {
      if (e.target === aiModal) {
        closeAIModalWithCheck();
      }
    };
  }

  // Sidebar click dismisses open modals (using capturing phase to intercept nav buttons/actions)
  const sidebar = $("#sidebar");
  if (sidebar) {
    sidebar.addEventListener("click", async (e) => {
      let modalActive = false;
      if (!$("#confirm-modal").classList.contains("hidden")) {
        modalActive = true;
        e.stopPropagation();
        e.preventDefault();
        $("#confirm-cancel").click();
      } else if (!$("#prompt-modal").classList.contains("hidden")) {
        modalActive = true;
        e.stopPropagation();
        e.preventDefault();
        $("#prompt-cancel").click();
      } else if (!$("#data-modal").classList.contains("hidden")) {
        modalActive = true;
        e.stopPropagation();
        e.preventDefault();
        $("#data-cancel").click();
      } else if (!$("#ai-modal").classList.contains("hidden")) {
        modalActive = true;
        e.stopPropagation();
        e.preventDefault();
        await closeAIModalWithCheck();
      } else if (!$("#sheet").classList.contains("hidden")) {
        modalActive = true;
        e.stopPropagation();
        e.preventDefault();
        closeSheet();
      }
    }, true);
  }

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
      const token = localStorage.getItem("ghostwaiter:session") || state.sessionToken;
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

  $("#sync-status").onclick = async () => {
    await performSync();
  };

  $("#sync-push-btn").onclick = async () => {
    $("#data-modal").classList.add("hidden");
    if (!(await showConfirm("Data in GitHub will be fully overwritten by your local data. Continue Push?"))) return;
    const overlay = $("#loading-overlay");
    const loadingText = $("#loading-text");
    try {
      loadingText.textContent = "Pushing to GitHub...";
      overlay.classList.remove("hidden");
      await jsonApi("/api/sync/push", {method: "POST"});
      overlay.classList.add("hidden");
      await loadSyncStatus();
      setTimeout(() => toast("Push sync completed", "success"), 50);
    } catch (error) {
      overlay.classList.add("hidden");
      setTimeout(() => toast(error.message, "error"), 50);
    }
  };

  $("#sync-pull-btn").onclick = async () => {
    $("#data-modal").classList.add("hidden");
    if (!(await showConfirm("Your local data will be overwritten by GitHub data. This cannot be undone. Continue Pull?"))) return;
    const overlay = $("#loading-overlay");
    const loadingText = $("#loading-text");
    try {
      loadingText.textContent = "Pulling from GitHub...";
      overlay.classList.remove("hidden");
      await jsonApi("/api/sync/pull", {method: "POST"});
      overlay.classList.add("hidden");
      setTimeout(() => {
        toast("Pull sync completed. Reloading...", "success");
        setTimeout(() => location.reload(), 1500);
      }, 50);
    } catch (error) {
      overlay.classList.add("hidden");
      setTimeout(() => toast(error.message, "error"), 50);
    }
  };

  $("#logout-button").onclick = async () => {
    await jsonApi("/api/auth/logout", {method: "POST"});
    localStorage.removeItem("ghostwaiter:session");
    state.sessionToken = "";
    location.reload();
  };
  $("#login-form").onsubmit = async event => {
    event.preventDefault();
    try {
      const result = await jsonApi("/api/auth/login", {method: "POST", body: {password: $("#login-password").value}});
      state.sessionToken = result.session_token || "";
      if (state.sessionToken) localStorage.setItem("ghostwaiter:session", state.sessionToken);
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
      toast("Workspace renamed");
      showWorkspaceSheet();
    }
  } catch (err) {
    toast(err.message, "error");
  }
};

window.deleteWorkspace = async function(id) {
  closeSheet();
  if (!(await showConfirm("Hapus workspace ini beserta seluruh isinya secara permanen?"))) return;
  try {
    const result = await jsonApi("/api/workspace/delete", {
      method: "POST",
      body: { workspace_id: id }
    });
    if (result.status === "success") {
      await loadWorkspaces();
      if (id === state.workspace) {
        await switchWorkspace("personal");
      }
      toast("Workspace deleted");
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
  if (!(await showConfirm("Hapus item ini?"))) return;
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

/* ─── Notes View Implementation (Google Keep Style) ────────────────── */

// Linkify plain URLs to clickable links
function linkify(text) {
  if (!text) return "";
  const urlPattern = /(\b(https?):\/\/[-A-Z0-9+&@#\/%?=~_|!:,.;]*[-A-Z0-9+&@#\/%=~_|])/ig;
  return text.replace(urlPattern, (url) => {
    return `<a href="${url}" target="_blank" rel="noopener noreferrer" onclick="event.stopPropagation()">${url}</a>`;
  });
}

// Client-side image compression: JPEG with dynamic canvas resize to stay < 128 KB
function compressImage(file, maxSizeBytes = 128 * 1024) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.readAsDataURL(file);
    reader.onload = (event) => {
      const img = new Image();
      img.src = event.target.result;
      img.onload = () => {
        const canvas = document.createElement("canvas");
        let ctx = canvas.getContext("2d");
        
        let width = img.width;
        let height = img.height;
        
        const maxDimension = 1200;
        if (width > maxDimension || height > maxDimension) {
          if (width > height) {
            height = Math.round((height * maxDimension) / width);
            width = maxDimension;
          } else {
            width = Math.round((width * maxDimension) / height);
            height = maxDimension;
          }
        }
        
        canvas.width = width;
        canvas.height = height;
        ctx.drawImage(img, 0, 0, width, height);
        
        let quality = 0.9;
        let dataUrl = canvas.toDataURL("image/jpeg", quality);
        
        while ((dataUrl.length * 3) / 4 > maxSizeBytes && quality > 0.1) {
          quality -= 0.1;
          dataUrl = canvas.toDataURL("image/jpeg", quality);
        }
        
        let scale = 0.8;
        while ((dataUrl.length * 3) / 4 > maxSizeBytes && scale > 0.1) {
          const w = Math.round(width * scale);
          const h = Math.round(height * scale);
          canvas.width = w;
          canvas.height = h;
          ctx.drawImage(img, 0, 0, w, h);
          dataUrl = canvas.toDataURL("image/jpeg", quality);
          scale -= 0.1;
        }
        
        resolve(dataUrl);
      };
      img.onerror = (err) => reject(err);
    };
    reader.onerror = (err) => reject(err);
  });
}

// Notes list loader
async function loadNotes() {
  if (!state.workspace) return;
  try {
    const res = await jsonApi(`/api/notes/list?workspace_id=${state.workspace}&query=${encodeURIComponent(state.notesSearch || '')}&tag=${encodeURIComponent(state.notesActiveTag || '')}`);
    state.notes = res.items || [];
    renderNotes();
  } catch (err) {
    console.error("Error loading notes", err);
    toast("Failed to load notes", "error");
  }
}

// Render Notes
function renderNotes() {
  const pinnedSection = $("#notes-pinned-section");
  const pinnedContainer = $("#notes-pinned-container");
  const othersTitle = $("#notes-others-title");
  const othersContainer = $("#notes-others-container");
  
  if (!pinnedSection || !pinnedContainer || !othersTitle || !othersContainer) return;
  
  const isGrid = state.notesLayout === "grid";
  pinnedContainer.className = isGrid ? "notes-grid" : "notes-list";
  othersContainer.className = isGrid ? "notes-grid" : "notes-list";
  
  const pinnedNotes = state.notes.filter(n => n.pinned);
  const otherNotes = state.notes.filter(n => !n.pinned);
  
  if (pinnedNotes.length > 0) {
    pinnedContainer.innerHTML = pinnedNotes.map(renderNoteCard).join("");
    pinnedSection.classList.remove("hidden");
    othersTitle.classList.remove("hidden");
  } else {
    pinnedContainer.innerHTML = "";
    pinnedSection.classList.add("hidden");
    othersTitle.classList.add("hidden");
  }
  
  othersContainer.innerHTML = otherNotes.map(renderNoteCard).join("");
  
  renderTagFilters();
  renderNotesSelectionStates();
}

// Render a single Note card
function renderNoteCard(note) {
  const isSelected = state.notesSelected.has(note.id);
  const imageHtml = note.image ? `<div class="note-card-image"><img src="${note.image}" alt="Note image"></div>` : "";
  
  const tagsHtml = note.tags && note.tags.length > 0
    ? `<div class="note-card-tags">` + note.tags.map(t => `<span class="note-card-tag" onclick="event.stopPropagation(); filterNotesByTag('${escapeHtml(t)}')">${escapeHtml(t)}</span>`).join("") + `</div>`
    : "";
    
  return `
    <article class="note-card ${isSelected ? 'selected' : ''}" data-id="${note.id}" onclick="handleNoteCardClick(event, '${note.id}')">
      <input type="checkbox" class="note-card-select-checkbox" ${isSelected ? 'checked' : ''} onclick="handleNoteCheckboxChange(event, '${note.id}')">
      
      <button class="note-card-pin-btn ${note.pinned ? 'active' : ''}" onclick="event.stopPropagation(); toggleNotePin('${note.id}')" title="${note.pinned ? 'Unpin note' : 'Pin note'}">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="17" x2="12" y2="22"/><path d="M5 17h14v-1.76a2 2 0 0 0-.44-1.24l-2.78-3.5A2 2 0 0 1 15 9.26V5a2 2 0 0 0-2-2h-2a2 2 0 0 0-2 2v4.26a2 2 0 0 1-.78 1.24l-2.78 3.5a2 2 0 0 0-.44 1.24Z"/></svg>
      </button>
      
      ${imageHtml}
      
      ${note.title ? `<h3 class="note-card-title">${escapeHtml(note.title)}</h3>` : ""}
      
      ${note.content ? `<div class="note-card-content">${linkify(escapeHtml(note.content))}</div>` : ""}
      
      ${tagsHtml}
      
      <div class="note-card-actions">
        <button class="note-card-action-btn" onclick="event.stopPropagation(); openEditNoteModal('${note.id}')" title="Edit note">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>
        </button>
        <button class="note-card-action-btn" onclick="event.stopPropagation(); deleteNoteDirect('${note.id}')" title="Delete note">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
        </button>
      </div>
    </article>
  `;
}

// Notes events initializer
let creatorPinned = false;
let creatorImage = null;

function initNotesSystem() {
  const collapsed = $("#note-creator-collapsed");
  const expanded = $("#note-creator-expanded");
  const creator = $("#note-creator");
  
  if (!collapsed || !expanded || !creator) return;
  
  collapsed.onclick = (e) => {
    e.stopPropagation();
    expandNoteCreator();
  };
  
  $("#note-pin-btn").onclick = () => {
    creatorPinned = !creatorPinned;
    $("#note-pin-btn").classList.toggle("active", creatorPinned);
  };
  
  $("#note-upload-btn").onclick = () => {
    $("#note-file-input").click();
  };
  
  $("#note-file-input").onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const compressed = await compressImage(file);
      creatorImage = compressed;
      $("#note-preview-img").src = compressed;
      $("#note-image-preview").classList.remove("hidden");
    } catch (err) {
      console.error(err);
      toast("Image compression failed", "error");
    }
  };
  
  $("#note-embed-btn").onclick = () => {
    const url = prompt("Enter image URL:");
    if (url) {
      creatorImage = url;
      $("#note-preview-img").src = url;
      $("#note-image-preview").classList.remove("hidden");
    }
  };
  
  $("#note-remove-img-btn").onclick = () => {
    creatorImage = null;
    $("#note-image-preview").classList.add("hidden");
    $("#note-preview-img").src = "";
    $("#note-file-input").value = "";
  };
  
  $("#note-save-btn").onclick = (e) => {
    e.stopPropagation();
    saveCurrentNoteFromCreator();
  };
  
  // Close and save on click outside creator card
  document.addEventListener("click", (e) => {
    if (!creator.contains(e.target) && !expanded.classList.contains("hidden")) {
      saveCurrentNoteFromCreator();
    }
  });
  
  // Grid/List Layout Toggle
  const layoutBtn = $("#notes-layout-btn");
  state.notesLayout = localStorage.getItem("ghostwaiter:notesLayout") || "grid";
  updateLayoutIcons();
  
  layoutBtn.onclick = () => {
    state.notesLayout = state.notesLayout === "grid" ? "list" : "grid";
    localStorage.setItem("ghostwaiter:notesLayout", state.notesLayout);
    updateLayoutIcons();
    renderNotes();
  };
  
  // Search filter
  const searchInput = $("#notes-search-input");
  let searchTimeout = null;
  searchInput.oninput = () => {
    clearTimeout(searchTimeout);
    searchTimeout = setTimeout(() => {
      state.notesSearch = searchInput.value;
      loadNotes();
    }, 300);
  };
  
  // Bulk buttons
  $("#notes-select-all-btn").onclick = () => notesSelectAll();
  $("#notes-deselect-all-btn").onclick = () => notesDeselectAll();
  $("#notes-bulk-delete-btn").onclick = () => notesBulkDelete();
}

function expandNoteCreator() {
  $("#note-creator-collapsed").classList.add("hidden");
  $("#note-creator-expanded").classList.remove("hidden");
  $("#note-content-input").focus();
}

function collapseNoteCreator() {
  $("#note-creator-collapsed").classList.remove("hidden");
  $("#note-creator-expanded").classList.add("hidden");
  
  $("#note-title-input").value = "";
  $("#note-content-input").value = "";
  $("#note-tags-input").value = "";
  $("#note-file-input").value = "";
  $("#note-preview-img").src = "";
  $("#note-image-preview").classList.add("hidden");
  
  creatorPinned = false;
  creatorImage = null;
  $("#note-pin-btn").classList.remove("active");
}

async function saveCurrentNoteFromCreator() {
  const title = $("#note-title-input").value.trim();
  const content = $("#note-content-input").value.trim();
  const tagsStr = $("#note-tags-input").value.trim();
  
  if (!title && !content && !creatorImage) {
    collapseNoteCreator();
    return;
  }
  
  const tags = tagsStr ? tagsStr.split(",").map(t => t.trim()).filter(t => t.length > 0) : [];
  
  const payload = {
    workspace_id: state.workspace,
    title,
    content,
    pinned: creatorPinned,
    tags,
    image: creatorImage
  };
  
  try {
    await jsonApi("/api/notes/save", {
      method: "POST",
      body: payload
    });
    toast("Note saved", "success");
    collapseNoteCreator();
    loadNotes();
  } catch (err) {
    console.error(err);
    toast("Failed to save note", "error");
  }
}

// Edit note modal
window.openEditNoteModal = function(noteId) {
  const note = state.notes.find(n => n.id === noteId);
  if (!note) return;
  
  let modalImageHtml = "";
  if (note.image) {
    modalImageHtml = `
      <div class="note-creator-image-preview" id="edit-note-image-preview">
        <img src="${note.image}" alt="Note image">
        <button type="button" class="remove-img-btn" onclick="removeEditNoteImage()">&times;</button>
      </div>
    `;
  }
  
  const modal = document.createElement("div");
  modal.className = "image-lightbox-modal";
  modal.id = "edit-note-modal";
  modal.innerHTML = `
    <div class="lightbox-backdrop" onclick="closeEditNoteModal(true)"></div>
    <div class="lightbox-content" style="max-width: 500px; width: 90%; background: var(--bg-surface); padding: 20px; border-radius: var(--radius-lg); border: 1px solid var(--border); box-shadow: var(--shadow-lg); display:flex; flex-direction:column; gap:12px;">
      <div style="display:flex; justify-content:space-between; align-items:center;">
        <input type="text" id="edit-note-title" class="note-creator-title" placeholder="Title" value="${escapeHtml(note.title || '')}" style="font-size:18px;">
        <button type="button" id="edit-note-pin" class="note-creator-pin-btn ${note.pinned ? 'active' : ''}" onclick="toggleEditNotePin()" title="Pin note">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="17" x2="12" y2="22"/><path d="M5 17h14v-1.76a2 2 0 0 0-.44-1.24l-2.78-3.5A2 2 0 0 1 15 9.26V5a2 2 0 0 0-2-2h-2a2 2 0 0 0-2 2v4.26a2 2 0 0 1-.78 1.24l-2.78 3.5a2 2 0 0 0-.44 1.24Z"/></svg>
        </button>
      </div>
      
      <textarea id="edit-note-content" class="note-creator-content" placeholder="Note" rows="6" style="min-height: 120px;">${escapeHtml(note.content || '')}</textarea>
      
      ${modalImageHtml}
      
      <div class="note-creator-actions" style="margin-top:8px; padding-top:8px;">
        <div class="note-creator-tools">
          <button type="button" class="note-creator-tool-btn" onclick="uploadEditNoteImage()" title="Add image file">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/></svg>
          </button>
          <button type="button" class="note-creator-tool-btn" onclick="embedEditNoteImage()" title="Add image URL">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>
          </button>
          <input type="text" id="edit-note-tags" class="note-creator-tags-input" placeholder="Tags" value="${escapeHtml((note.tags || []).join(', '))}">
        </div>
        <div style="display:flex; gap:8px;">
          <button type="button" onclick="deleteNoteDirect('${note.id}')" class="button compact danger" style="padding: 6px 12px;">Delete</button>
          <button type="button" onclick="closeEditNoteModal(true)" class="button primary compact" style="padding: 6px 12px;">Close</button>
        </div>
      </div>
      <input type="file" id="edit-note-file-input" class="hidden" accept="image/*" onchange="handleEditNoteImageUpload(event)">
    </div>
  `;
  document.body.appendChild(modal);
  
  window.currentEditNote = {
    id: note.id,
    pinned: note.pinned,
    image: note.image
  };
};

window.toggleEditNotePin = function() {
  window.currentEditNote.pinned = !window.currentEditNote.pinned;
  const pinBtn = $("#edit-note-pin");
  pinBtn.classList.toggle("active", window.currentEditNote.pinned);
};

window.removeEditNoteImage = function() {
  window.currentEditNote.image = null;
  $("#edit-note-image-preview")?.remove();
};

window.uploadEditNoteImage = function() {
  $("#edit-note-file-input").click();
};

window.handleEditNoteImageUpload = async function(event) {
  const file = event.target.files[0];
  if (!file) return;
  try {
    const compressed = await compressImage(file);
    window.currentEditNote.image = compressed;
    
    let preview = $("#edit-note-image-preview");
    if (!preview) {
      preview = document.createElement("div");
      preview.className = "note-creator-image-preview";
      preview.id = "edit-note-image-preview";
      preview.innerHTML = `
        <img src="${compressed}" alt="Note image">
        <button type="button" class="remove-img-btn" onclick="removeEditNoteImage()">&times;</button>
      `;
      const txt = $("#edit-note-content");
      txt.parentNode.insertBefore(preview, txt.nextSibling);
    } else {
      preview.querySelector("img").src = compressed;
    }
  } catch (err) {
    console.error(err);
    toast("Image upload failed", "error");
  }
};

window.embedEditNoteImage = function() {
  const url = prompt("Enter image URL:");
  if (url) {
    window.currentEditNote.image = url;
    let preview = $("#edit-note-image-preview");
    if (!preview) {
      preview = document.createElement("div");
      preview.className = "note-creator-image-preview";
      preview.id = "edit-note-image-preview";
      preview.innerHTML = `
        <img src="${url}" alt="Note image">
        <button type="button" class="remove-img-btn" onclick="removeEditNoteImage()">&times;</button>
      `;
      const txt = $("#edit-note-content");
      txt.parentNode.insertBefore(preview, txt.nextSibling);
    } else {
      preview.querySelector("img").src = url;
    }
  }
};

window.deleteNoteDirect = async function(noteId) {
  if (!confirm("Delete this note?")) return;
  try {
    await jsonApi("/api/notes/delete", {
      method: "POST",
      body: { workspace_id: state.workspace, note_id: noteId }
    });
    toast("Note deleted", "success");
    closeEditNoteModal(false);
    loadNotes();
  } catch (err) {
    console.error(err);
    toast("Failed to delete note", "error");
  }
};

window.closeEditNoteModal = async function(save = true) {
  const modal = $("#edit-note-modal");
  if (!modal) return;
  
  if (save && window.currentEditNote) {
    const title = $("#edit-note-title").value.trim();
    const content = $("#edit-note-content").value.trim();
    const tagsStr = $("#edit-note-tags").value.trim();
    const tags = tagsStr ? tagsStr.split(",").map(t => t.trim()).filter(t => t.length > 0) : [];
    
    const payload = {
      workspace_id: state.workspace,
      id: window.currentEditNote.id,
      title,
      content,
      pinned: window.currentEditNote.pinned,
      tags,
      image: window.currentEditNote.image
    };
    
    try {
      await jsonApi("/api/notes/save", {
        method: "POST",
        body: payload
      });
      loadNotes();
    } catch (err) {
      console.error(err);
      toast("Failed to save note changes", "error");
    }
  }
  
  modal.remove();
  window.currentEditNote = null;
};

// Toggle note pin
window.toggleNotePin = async function(noteId) {
  const note = state.notes.find(n => n.id === noteId);
  if (!note) return;
  
  note.pinned = !note.pinned;
  note.updated_at = new Date().toISOString();
  
  try {
    await jsonApi("/api/notes/save", {
      method: "POST",
      body: {
        workspace_id: state.workspace,
        id: note.id,
        title: note.title,
        content: note.content,
        pinned: note.pinned,
        tags: note.tags,
        image: note.image
      }
    });
    loadNotes();
  } catch (err) {
    console.error(err);
    toast("Failed to update note pin", "error");
  }
};

// Note Selection & Bulk Action handlers
window.handleNoteCardClick = function(event, noteId) {
  if (event.target.closest('.note-card-actions') || 
      event.target.closest('.note-card-select-checkbox') || 
      event.target.closest('.note-card-pin-btn') ||
      event.target.tagName === 'A') {
    return;
  }
  
  if (state.notesSelected.size > 0) {
    toggleNoteSelection(noteId);
  } else {
    openEditNoteModal(noteId);
  }
};

window.handleNoteCheckboxChange = function(event, noteId) {
  event.stopPropagation();
  if (event.target.checked) {
    state.notesSelected.add(noteId);
  } else {
    state.notesSelected.delete(noteId);
  }
  updateBulkActionsBar();
  renderNotesSelectionStates();
};

function toggleNoteSelection(noteId) {
  if (state.notesSelected.has(noteId)) {
    state.notesSelected.delete(noteId);
  } else {
    state.notesSelected.add(noteId);
  }
  updateBulkActionsBar();
  renderNotesSelectionStates();
}

function updateBulkActionsBar() {
  const bar = $("#notes-bulk-bar");
  const info = $("#notes-bulk-info");
  if (!bar || !info) return;
  
  const count = state.notesSelected.size;
  if (count > 0) {
    info.textContent = `${count} note${count > 1 ? 's' : ''} selected`;
    bar.classList.remove("hidden");
  } else {
    bar.classList.add("hidden");
  }
}

function renderNotesSelectionStates() {
  state.notes.forEach(note => {
    const card = $(`.note-card[data-id="${note.id}"]`);
    const checkbox = card?.querySelector('.note-card-select-checkbox');
    if (card && checkbox) {
      const isSelected = state.notesSelected.has(note.id);
      card.classList.toggle("selected", isSelected);
      checkbox.checked = isSelected;
    }
  });
}

window.notesSelectAll = function() {
  state.notes.forEach(note => state.notesSelected.add(note.id));
  updateBulkActionsBar();
  renderNotesSelectionStates();
};

window.notesDeselectAll = function() {
  state.notesSelected.clear();
  updateBulkActionsBar();
  renderNotesSelectionStates();
};

window.notesBulkDelete = async function() {
  if (state.notesSelected.size === 0) return;
  if (!confirm(`Delete ${state.notesSelected.size} selected note(s)?`)) return;
  
  try {
    await jsonApi("/api/notes/delete-bulk", {
      method: "POST",
      body: {
        workspace_id: state.workspace,
        note_ids: Array.from(state.notesSelected)
      }
    });
    toast("Notes deleted", "success");
    state.notesSelected.clear();
    updateBulkActionsBar();
    loadNotes();
  } catch (err) {
    console.error(err);
    toast("Failed to delete notes", "error");
  }
};

// Tag filter chips rendering
function renderTagFilters() {
  const filterContainer = $("#notes-tag-filters");
  if (!filterContainer) return;
  
  const allTags = new Set();
  state.notes.forEach(note => {
    if (note.tags) {
      note.tags.forEach(t => allTags.add(t));
    }
  });
  
  const tagsArray = Array.from(allTags).sort();
  
  if (tagsArray.length === 0) {
    filterContainer.innerHTML = "";
    return;
  }
  
  let html = `<span style="font-size:12px; color:var(--text-muted);">Tags:</span>`;
  html += `<button class="chip ${!state.notesActiveTag ? 'active' : ''}" onclick="filterNotesByTag('')" type="button">All</button>`;
  
  tagsArray.forEach(tag => {
    const isActive = state.notesActiveTag === tag;
    html += `<button class="chip ${isActive ? 'active' : ''}" onclick="filterNotesByTag('${escapeHtml(tag)}')" type="button">${escapeHtml(tag)}</button>`;
  });
  
  filterContainer.innerHTML = html;
}

window.filterNotesByTag = function(tag) {
  state.notesActiveTag = tag;
  loadNotes();
};

function updateLayoutIcons() {
  const gridIcon = $("#notes-grid-icon");
  const listIcon = $("#notes-list-icon");
  if (!gridIcon || !listIcon) return;
  
  if (state.notesLayout === "grid") {
    gridIcon.classList.remove("hidden");
    listIcon.classList.add("hidden");
  } else {
    gridIcon.classList.add("hidden");
    listIcon.classList.remove("hidden");
  }
}

