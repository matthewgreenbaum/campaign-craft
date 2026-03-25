    const CONFIG = {
      ANTHROPIC_API_KEY: "PASTE_YOUR_API_KEY_HERE"
    };

    // ─── state ───
    let conversationHistory = [];   // {role, content} messages sent to API
    let chatBusy = false;
    let blueprintBusy = false;
    let currentCampaignId = null;

    // ─── progress tracking ───
    // Section-based progress: tracks completed sections via AI directives.
    const PROGRESS_TOTAL_SECTIONS = 22;
    let completedSections = new Set();
    let rawBlueprintMarkdown = ""; // raw markdown of the current blueprint
    let blueprintPendingRerun = false; // queued re-run after current stream finishes

    function launchConfetti() {
      const container = document.createElement("div");
      container.className = "confetti-container";
      document.body.appendChild(container);
      const colors = ["#3D38B0", "#7B7BD0", "#F97316", "#EC4899", "#16a34a", "#facc15", "#06b6d4"];
      const shapes = ["square", "circle"];
      for (let i = 0; i < 80; i++) {
        const piece = document.createElement("div");
        piece.className = "confetti-piece";
        const color = colors[Math.floor(Math.random() * colors.length)];
        const shape = shapes[Math.floor(Math.random() * shapes.length)];
        piece.style.left = Math.random() * 100 + "vw";
        piece.style.background = color;
        piece.style.borderRadius = shape === "circle" ? "50%" : "2px";
        piece.style.width = (6 + Math.random() * 8) + "px";
        piece.style.height = (6 + Math.random() * 8) + "px";
        piece.style.animationDelay = (Math.random() * 0.8) + "s";
        piece.style.animationDuration = (1.8 + Math.random() * 1.2) + "s";
        container.appendChild(piece);
      }
      setTimeout(() => container.remove(), 4000);
    }

    // ─── phase definitions ───
    // Maps phase number → { name, sections (range of section IDs) }
    const PHASES = [
      { id: 1, name: "Foundation",  sections: [1, 2, 3] },
      { id: 2, name: "Strategy",    sections: [4, 5, 6, 7] },
      { id: 3, name: "Insight",     sections: [8, 9, 10, 11, 12] },
      { id: 4, name: "Planning",    sections: [13, 14, 15, 16, 17, 18, 19] },
      { id: 5, name: "Stress Test", sections: [20, 21] },
      { id: 6, name: "Decision",    sections: [22] },
    ];

    // Blueprint section names in order (matches the numbered ## headings in the output)
    const BP_SECTION_NAMES = [
      "Executive Summary",         // 1
      "Campaign Concept",          // 2
      "Target Audience & Sales Motion", // 3
      "Business Goal & Impact Type",    // 4
      "KPIs & Measurement",        // 5
      "Core Insight",              // 6
      "Hypothesis",                // 7
      "Scope & Size",              // 8
      "Timeline",                  // 9
      "Needs Assessment",          // 10
      "Blind Spots & Assumptions", // 11
      "Strategic Quality Assessment", // 12
    ];

    // Blueprint skeleton layout — maps phases to sections in display order.
    // Each section has its canonical number, name, and description for the skeleton.
    const BLUEPRINT_LAYOUT = [
      { phase: "1. Foundation", sections: [
        { num: 2, name: "Campaign Concept", desc: "Elevator pitch — what you're doing and why it matters to your audience" },
      ]},
      { phase: "2. Strategy", sections: [
        { num: 3, name: "Target Audience & Sales Motion", desc: "Who you're reaching and how you sell to them" },
        { num: 4, name: "Business Goal & Impact Type", desc: "What business outcome this campaign drives" },
        { num: 5, name: "KPIs & Measurement", desc: "How you'll know it's working" },
      ]},
      { phase: "3. Insight & Thesis", sections: [
        { num: 6, name: "Core Insight", desc: "The audience truth that makes this campaign resonate" },
        { num: 7, name: "Hypothesis", desc: "If we [action] for [persona], then [outcome] because [insight]" },
      ]},
      { phase: "4. Planning & Requirements", sections: [
        { num: 8, name: "Scope & Size", desc: "T-shirt size based on channels, content, teams, and duration" },
        { num: 9, name: "Timeline", desc: "Expected duration and key milestones" },
        { num: 10, name: "Needs Assessment", desc: "Content & creative assets, channels, sales enablement, teams & ops, localization" },
      ]},
      { phase: "5. Stress Test", sections: [
        { num: 11, name: "Blind Spots & Assumptions", desc: "Risks and blind spots you might have missed" },
        { num: 12, name: "Strategic Quality Assessment", desc: "Alignment, impact potential, and readiness evaluation" },
      ]},
    ];
    // Executive Summary (section 1) is a synthesis section displayed at the top
    // of the blueprint but generated last, after all other sections have data.

    // Parse blueprint markdown into { title, sections: { num: contentHtml } }
    function parseBlueprintSections(md) {
      if (!md) return { title: "", sections: {} };
      const lines = md.split("\n");
      let title = "";
      const sections = {};
      let currentNum = null;
      let currentLines = [];

      function flush() {
        if (currentNum !== null && currentLines.length > 0) {
          sections[currentNum] = currentLines.join("\n");
        }
        currentLines = [];
      }

      for (const line of lines) {
        // Campaign title: # heading
        const titleMatch = line.match(/^#\s+(.+)/);
        if (titleMatch && !line.match(/^##/)) {
          title = titleMatch[1].trim();
          continue;
        }
        // Section heading: ## N. Section Name
        const secMatch = line.match(/^##\s+(\d+)\.\s+/);
        if (secMatch) {
          flush();
          currentNum = parseInt(secMatch[1]);
          // Include the heading line itself in the section content
          currentLines.push(line);
          continue;
        }
        if (currentNum !== null) {
          currentLines.push(line);
        }
      }
      flush();
      return { title, sections };
    }

    // Reconstruct blueprint markdown from parsed title + sections object
    function buildBlueprintMarkdown(title, sections) {
      let md = "";
      if (title) md += `# ${title}\n\n`;
      for (let i = 1; i <= 12; i++) {
        if (sections[i]) {
          md += sections[i] + "\n\n";
        }
      }
      return md.trim();
    }

    // Strip chat-style blue spans from blueprint content — these are for chat transitions only
    function stripChatSpans(text) {
      return text.replace(/<span\s+style="[^"]*">(.*?)<\/span>/gi, "$1");
    }

    // Merge a single blueprint section into rawBlueprintMarkdown and re-render the preview
    function mergeBlueprintSection(num, content) {
      const parsed = parseBlueprintSections(rawBlueprintMarkdown);
      parsed.sections[num] = content;

      // If we have a campaign title from the sidebar but not in the blueprint, add it
      if (!parsed.title && currentCampaignId) {
        const campaigns = loadAllCampaigns();
        const camp = campaigns.find(c => c.id === currentCampaignId);
        if (camp && camp.title && camp.title !== "Untitled Campaign") {
          parsed.title = camp.title;
        }
      }

      rawBlueprintMarkdown = buildBlueprintMarkdown(parsed.title, parsed.sections);

      const bpEl = $("#bpContent");
      bpEl.innerHTML = renderBlueprintWithPhases(rawBlueprintMarkdown);
      bpEl.classList.add("visible");
      $("#bpPlaceholder").style.display = "none";
      $("#copyBtn").classList.add("visible");
      $("#exportDropdown").classList.add("visible");
      saveCurrent();
    }

    function getPhaseStatus(phase) {
      const allDone = phase.sections.every(s => completedSections.has(s));
      const anyDone = phase.sections.some(s => completedSections.has(s));
      if (allDone) return "completed";
      if (anyDone) return "active";
      // Check if previous phase is completed → this is active
      const prevPhase = PHASES.find(p => p.id === phase.id - 1);
      if (!prevPhase || prevPhase.sections.every(s => completedSections.has(s))) return "active";
      return "pending";
    }

    function updatePhaseStepper() {
      let foundActive = false;
      PHASES.forEach((phase, idx) => {
        const stepEl = document.getElementById(`phaseStep${phase.id}`);
        const connEl = document.getElementById(`phaseConn${phase.id}`);
        if (!stepEl) return;

        const status = getPhaseStatus(phase);
        stepEl.classList.remove("completed", "active");
        if (connEl) connEl.classList.remove("completed");

        if (status === "completed") {
          stepEl.classList.add("completed");
          stepEl.querySelector(".phase-step-icon").innerHTML = "&#10003;";
          if (connEl) connEl.classList.add("completed");
        } else if (status === "active" && !foundActive) {
          stepEl.classList.add("active");
          stepEl.querySelector(".phase-step-icon").textContent = phase.id;
          foundActive = true;
        } else {
          stepEl.querySelector(".phase-step-icon").textContent = phase.id;
        }
      });
    }

    function updateProgress() {
      const pct = Math.min(100, Math.round((completedSections.size / PROGRESS_TOTAL_SECTIONS) * 100));
      const fill = document.getElementById("chatProgressFill");
      if (fill) fill.style.width = pct + "%";
      updatePhaseStepper();
      // Re-render skeleton to update active phase indicator
      if (!blueprintBusy) {
        $("#bpContent").innerHTML = renderBlueprintWithPhases(rawBlueprintMarkdown);
      }
    }

    // Restore progress from conversation history (for returning sessions)
    function restoreProgressFromHistory() {
      completedSections.clear();
      conversationHistory.forEach(m => {
        if (m.role === "assistant") {
          const matches = m.content.matchAll(/<!--SECTION_COMPLETE:(\d+)-->/g);
          for (const match of matches) {
            completedSections.add(parseInt(match[1]));
          }
        }
      });
      updateProgress();
    }

    // ─── bot avatar (geodesic dome) ───
    const BOT_AVATAR_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><defs><radialGradient id="g" cx="35%" cy="30%" r="65%"><stop offset="0%" stop-color="#5551db"/><stop offset="100%" stop-color="#312da0"/></radialGradient></defs><circle cx="50" cy="50" r="50" fill="url(#g)"/><g fill="none" stroke="rgba(255,255,255,0.45)" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="M50,50L74,42.2M50,50L64.8,70.4M50,50L35.2,70.4M50,50L26,42.2M50,50L50,24.8M24.8,84.7L50,90.8M24.8,84.7L35.2,70.4M24.8,84.7L11.2,62.6M24.8,84.7L35.2,95.7M24.8,84.7L11.2,78.2M90.8,36.7L74,42.2M90.8,36.7L88.8,62.6M90.8,36.7L74,17M90.8,36.7L98,50M90.8,36.7L88.8,21.8M50,7.1L26,17M50,7.1L50,24.8M50,7.1L74,17M50,7.1L35.2,4.3M50,7.1L64.8,4.3M75.2,84.7L88.8,62.6M75.2,84.7L64.8,70.4M75.2,84.7L50,90.8M75.2,84.7L88.8,78.2M75.2,84.7L64.8,95.7M9.2,36.7L11.2,62.6M9.2,36.7L26,42.2M9.2,36.7L26,17M9.2,36.7L2,50M9.2,36.7L11.2,21.8M74,42.2L88.8,62.6M74,42.2L64.8,70.4M74,42.2L50,24.8M74,42.2L74,17M88.8,62.6L64.8,70.4M88.8,62.6L98,50M88.8,62.6L88.8,78.2M64.8,70.4L50,90.8M64.8,70.4L35.2,70.4M50,90.8L35.2,70.4M50,90.8L64.8,95.7M50,90.8L35.2,95.7M35.2,70.4L11.2,62.6M35.2,70.4L26,42.2M11.2,62.6L26,42.2M11.2,62.6L11.2,78.2M11.2,62.6L2,50M26,42.2L26,17M26,42.2L50,24.8M26,17L50,24.8M26,17L11.2,21.8M26,17L35.2,4.3M50,24.8L74,17M74,17L64.8,4.3M74,17L88.8,21.8M98,50L88.8,78.2M98,50L88.8,21.8M88.8,78.2L64.8,95.7M64.8,95.7L35.2,95.7M35.2,95.7L11.2,78.2M11.2,78.2L2,50M2,50L11.2,21.8M11.2,21.8L35.2,4.3M35.2,4.3L64.8,4.3M64.8,4.3L88.8,21.8"/></g></svg>`;

    function getBotAvatarImg() {
      const blob = new Blob([BOT_AVATAR_SVG], { type: "image/svg+xml" });
      const url = URL.createObjectURL(blob);
      return `<img src="${url}" alt="AI Assistant" class="bot-avatar-img">`;
    }

    // ─── avatar persistence ───
    const AVATAR_STORAGE_KEY = "userAvatar";

    const AVATAR_PRESETS = [
      { emoji: "🥑", name: "Avocado" },
      { emoji: "🌼", name: "Poppy" },
      { emoji: "☯️", name: "Yin Yang" },
      { emoji: "🌍", name: "Earth" },
      { emoji: "🔴", name: "Mars" },
      { emoji: "☀️", name: "Sun" },
      { emoji: "🚀", name: "Rocket" },
      { emoji: "🦊", name: "Fox" },
      { emoji: "🌊", name: "Wave" },
      { emoji: "🎯", name: "Bullseye" },
      { emoji: "🐻", name: "Bear" },
      { emoji: "💎", name: "Gem" },
    ];

    // Avatar state: { type: "default" | "emoji" | "upload", value: string }
    function loadAvatar() {
      try {
        return JSON.parse(localStorage.getItem(AVATAR_STORAGE_KEY)) || { type: "default" };
      } catch { return { type: "default" }; }
    }

    function saveAvatar(avatar) {
      localStorage.setItem(AVATAR_STORAGE_KEY, JSON.stringify(avatar));
    }

    function renderAvatarInto(el, avatar) {
      if (!avatar || avatar.type === "default") {
        el.innerHTML = "You";
        el.style.background = "#1c767b";
      } else if (avatar.type === "emoji") {
        el.innerHTML = `<span class="emoji-avatar">${avatar.value}</span>`;
        el.style.background = "#1c767b";
      } else if (avatar.type === "upload") {
        el.innerHTML = `<img src="${avatar.value}" alt="avatar">`;
        el.style.background = "#1c767b";
      }
    }

    function refreshAllUserAvatars() {
      const avatar = loadAvatar();
      // Sidebar preview
      const sidebarPrev = document.getElementById("sidebarAvatarPreview");
      if (sidebarPrev) renderAvatarInto(sidebarPrev, avatar);
      // All chat message avatars for user
      document.querySelectorAll(".msg-row.user .msg-avatar").forEach(el => {
        renderAvatarInto(el, avatar);
      });
    }

    function openAvatarPicker() {
      const backdrop = document.getElementById("avatarModalBackdrop");
      backdrop.classList.add("visible");
      const avatar = loadAvatar();

      // Render current preview
      renderAvatarInto(document.getElementById("avatarCurrentPreview"), avatar);
      const label = document.getElementById("avatarCurrentLabel");
      if (avatar.type === "default") label.textContent = "Default";
      else if (avatar.type === "emoji") label.textContent = AVATAR_PRESETS.find(p => p.emoji === avatar.value)?.name || "Preset";
      else label.textContent = "Custom photo";

      // Build presets grid
      const grid = document.getElementById("avatarPresetsGrid");
      grid.innerHTML = "";
      AVATAR_PRESETS.forEach(p => {
        const item = document.createElement("div");
        item.className = "avatar-preset-item" + (avatar.type === "emoji" && avatar.value === p.emoji ? " selected" : "");
        item.innerHTML = `<span class="preset-emoji">${p.emoji}</span><span class="preset-name">${p.name}</span>`;
        item.addEventListener("click", () => selectPresetAvatar(p.emoji));
        grid.appendChild(item);
      });
    }

    function closeAvatarPicker(e) {
      if (e && e.target !== document.getElementById("avatarModalBackdrop")) return;
      document.getElementById("avatarModalBackdrop").classList.remove("visible");
    }

    function selectPresetAvatar(emoji) {
      const avatar = { type: "emoji", value: emoji };
      saveAvatar(avatar);
      refreshAllUserAvatars();
      openAvatarPicker(); // refresh modal state
    }

    function handleAvatarUpload(event) {
      const file = event.target.files[0];
      if (!file) return;
      if (file.size > 2 * 1024 * 1024) {
        alert("Image must be under 2 MB.");
        return;
      }
      const reader = new FileReader();
      reader.onload = function(e) {
        const avatar = { type: "upload", value: e.target.result };
        saveAvatar(avatar);
        refreshAllUserAvatars();
        openAvatarPicker(); // refresh modal state
      };
      reader.readAsDataURL(file);
      event.target.value = ""; // reset so same file can be re-selected
    }

    function removeAvatar() {
      saveAvatar({ type: "default" });
      refreshAllUserAvatars();
      openAvatarPicker(); // refresh modal state
    }

    // ─── avatar display name ───
    const NAME_STORAGE_KEY = "userDisplayName";

    function loadDisplayName() {
      return localStorage.getItem(NAME_STORAGE_KEY) || "Your Avatar";
    }

    function saveDisplayName(name) {
      localStorage.setItem(NAME_STORAGE_KEY, name);
    }

    function refreshDisplayName() {
      const el = document.getElementById("sidebarAvatarName");
      if (el) el.textContent = loadDisplayName();
    }

    function editAvatarName() {
      const nameEl = document.getElementById("sidebarAvatarName");
      const current = loadDisplayName();

      const input = document.createElement("input");
      input.type = "text";
      input.value = current === "Your Avatar" ? "" : current;
      input.placeholder = "Enter your name";
      input.style.cssText = "background:rgba(255,255,255,0.15);border:1px solid rgba(255,255,255,0.3);border-radius:4px;color:#fff;font-family:inherit;font-size:0.88rem;font-weight:600;padding:2px 6px;outline:none;width:100%;";
      nameEl.replaceWith(input);
      input.focus();
      input.select();

      function commit() {
        const val = input.value.trim();
        const finalName = val || "Your Avatar";
        saveDisplayName(finalName);

        const span = document.createElement("span");
        span.className = "sidebar-avatar-name";
        span.id = "sidebarAvatarName";
        span.title = "Click to edit name";
        span.textContent = finalName;
        span.addEventListener("click", editAvatarName);
        input.replaceWith(span);
      }

      input.addEventListener("blur", commit);
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") { e.preventDefault(); input.blur(); }
        if (e.key === "Escape") { input.value = current; input.blur(); }
      });
    }

    // ─── campaign persistence ───
    const STORAGE_KEY = "campaignBlueprints";

    function loadAllCampaigns() {
      try {
        return JSON.parse(localStorage.getItem(STORAGE_KEY)) || [];
      } catch { return []; }
    }

    function saveAllCampaigns(campaigns) {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(campaigns));
    }

    function generateId() {
      return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
    }

    function updateBlueprintPanelTitle() {
      const el = $("#blueprintPanelTitle");
      if (!currentCampaignId) { el.textContent = ""; return; }
      const campaigns = loadAllCampaigns();
      const c = campaigns.find(c => c.id === currentCampaignId);
      el.textContent = c ? c.title : "";
    }

    // Extract hidden directives from assistant reply (title + section progress + inline blueprint)
    function extractDirectives(reply) {
      // Extract campaign title
      const titleMatch = reply.match(/<!--CAMPAIGN_TITLE:(.+?)-->/);
      if (titleMatch) {
        let name = titleMatch[1].trim().replace(/^["'""'']+|["'""'']+$/g, "").trim();
        if (name && currentCampaignId) {
          const campaigns = loadAllCampaigns();
          const idx = campaigns.findIndex(c => c.id === currentCampaignId);
          if (idx !== -1) {
            campaigns[idx].title = name.slice(0, 60) + (name.length > 60 ? "…" : "");
            saveAllCampaigns(campaigns);
            renderCampaignList();
            updateBlueprintPanelTitle();
          }
        }
      }
      // Extract section progress
      const sectionMatches = reply.matchAll(/<!--SECTION_COMPLETE:(\d+)-->/g);
      for (const m of sectionMatches) {
        const sec = parseInt(m[1]);
        completedSections.add(sec);
        if (sec === 22) setTimeout(launchConfetti, 500);
      }
      updateProgress();

      // Extract inline blueprint sections and merge into preview immediately
      const bpRegex = /<!--BP_START:(\d+)-->([\s\S]*?)<!--BP_END:\d+-->/g;
      let bpMatch;
      while ((bpMatch = bpRegex.exec(reply)) !== null) {
        const secNum = parseInt(bpMatch[1]);
        // Strip chat-style blue spans — they're for chat transitions, not blueprint content
        let secContent = stripChatSpans(bpMatch[2].trim());
        if (secContent) {
          mergeBlueprintSection(secNum, secContent);
        }
      }

      // Strip all directives from the displayed reply
      return reply
        .replace(/<!--CAMPAIGN_TITLE:.+?-->\n?/g, "")
        .replace(/<!--SECTION_COMPLETE:\d+-->\n?/g, "")
        .replace(/<!--BP_START:\d+-->[\s\S]*?<!--BP_END:\d+-->\n?/g, "")
        .trim();
    }

    // Strip directive comments for display (without side effects)
    function stripDirectives(text) {
      return text
        .replace(/<!--CAMPAIGN_TITLE:.+?-->\n?/g, "")
        .replace(/<!--SECTION_COMPLETE:\d+-->\n?/g, "")
        .replace(/<!--BP_START:\d+-->[\s\S]*?<!--BP_END:\d+-->\n?/g, "")
        .trim();
    }

    function saveCurrent() {
      if (!currentCampaignId) return;
      const campaigns = loadAllCampaigns();
      const idx = campaigns.findIndex(c => c.id === currentCampaignId);
      if (idx === -1) return;

      // Title is set via CAMPAIGN_TITLE directive parsed from assistant replies — no auto-derive here.

      campaigns[idx].conversationHistory = conversationHistory;
      campaigns[idx].blueprintMarkdown = rawBlueprintMarkdown;
      campaigns[idx].updatedAt = Date.now();
      saveAllCampaigns(campaigns);
      renderCampaignList();
      updateBlueprintPanelTitle();
    }

    // ─── campaign ordering ───
    const ORDER_STORAGE_KEY = "campaignOrder";

    function loadCampaignOrder() {
      try {
        return JSON.parse(localStorage.getItem(ORDER_STORAGE_KEY)) || null;
      } catch { return null; }
    }

    function saveCampaignOrder(ids) {
      localStorage.setItem(ORDER_STORAGE_KEY, JSON.stringify(ids));
    }

    function getOrderedCampaigns(campaigns) {
      const order = loadCampaignOrder();
      if (!order) {
        // Default: sort by most recently updated
        campaigns.sort((a, b) => b.updatedAt - a.updatedAt);
        return campaigns;
      }
      // Sort by saved order; new campaigns (not in order) go to top
      const orderMap = new Map(order.map((id, i) => [id, i]));
      campaigns.sort((a, b) => {
        const ai = orderMap.has(a.id) ? orderMap.get(a.id) : -1;
        const bi = orderMap.has(b.id) ? orderMap.get(b.id) : -1;
        if (ai === -1 && bi === -1) return b.updatedAt - a.updatedAt;
        if (ai === -1) return -1;
        if (bi === -1) return 1;
        return ai - bi;
      });
      return campaigns;
    }

    // ─── search/filter ───
    function filterCampaigns() {
      const query = ($("#campaignSearch").value || "").toLowerCase().trim();
      const items = $$("#campaignList .campaign-item");
      let visibleCount = 0;
      items.forEach(item => {
        const title = item.querySelector(".campaign-item-title").textContent.toLowerCase();
        const match = !query || title.includes(query);
        item.style.display = match ? "" : "none";
        if (match) visibleCount++;
      });
      // Show/hide empty state only when no search and truly empty
      const empty = $("#sidebarEmpty");
      if (!query && visibleCount === 0 && items.length === 0) {
        empty.style.display = "block";
      } else {
        empty.style.display = "none";
      }
    }

    function renderCampaignList() {
      let campaigns = loadAllCampaigns();
      const list = $("#campaignList");
      const empty = $("#sidebarEmpty");

      // Remove all items except the empty placeholder
      list.querySelectorAll(".campaign-item").forEach(el => el.remove());

      if (campaigns.length === 0) {
        empty.style.display = "block";
        return;
      }
      empty.style.display = "none";

      campaigns = getOrderedCampaigns(campaigns);

      campaigns.forEach(c => {
        const div = document.createElement("div");
        div.className = "campaign-item" + (c.id === currentCampaignId ? " active" : "");
        div.dataset.campaignId = c.id;
        div.draggable = true;
        div.innerHTML = `
          <div class="campaign-item-info">
            <div class="campaign-item-title">${escapeHTML(c.title)}</div>
            <div class="campaign-item-date">${formatDate(c.updatedAt)}</div>
          </div>
          <div class="campaign-item-menu">
            <button class="campaign-item-dots" title="Options">&#8942;</button>
            <div class="campaign-item-dropdown">
              <button data-action="rename">Edit Title</button>
              <button data-action="delete" class="danger">Delete</button>
            </div>
          </div>
        `;
        div.querySelector(".campaign-item-info").addEventListener("click", () => switchCampaign(c.id));
        div.querySelector(".campaign-item-dots").addEventListener("click", (e) => {
          e.stopPropagation();
          closeAllDropdowns();
          div.querySelector(".campaign-item-dropdown").classList.toggle("open");
        });
        div.querySelector('[data-action="rename"]').addEventListener("click", (e) => {
          e.stopPropagation();
          closeAllDropdowns();
          renameCampaign(c.id);
        });
        div.querySelector('[data-action="delete"]').addEventListener("click", (e) => {
          e.stopPropagation();
          closeAllDropdowns();
          deleteCampaign(c.id);
        });

        // Drag-to-reorder events
        div.addEventListener("dragstart", (e) => {
          e.dataTransfer.effectAllowed = "move";
          e.dataTransfer.setData("text/plain", c.id);
          requestAnimationFrame(() => div.classList.add("dragging"));
        });
        div.addEventListener("dragend", () => {
          div.classList.remove("dragging");
          list.querySelectorAll(".campaign-item").forEach(el => el.classList.remove("drag-over"));
        });
        div.addEventListener("dragover", (e) => {
          e.preventDefault();
          e.dataTransfer.dropEffect = "move";
          list.querySelectorAll(".campaign-item").forEach(el => el.classList.remove("drag-over"));
          if (!div.classList.contains("dragging")) div.classList.add("drag-over");
        });
        div.addEventListener("dragleave", () => {
          div.classList.remove("drag-over");
        });
        div.addEventListener("drop", (e) => {
          e.preventDefault();
          div.classList.remove("drag-over");
          const draggedId = e.dataTransfer.getData("text/plain");
          if (draggedId === c.id) return;
          // Compute new order
          const items = [...list.querySelectorAll(".campaign-item")];
          const ids = items.map(el => el.dataset.campaignId);
          const fromIdx = ids.indexOf(draggedId);
          const toIdx = ids.indexOf(c.id);
          if (fromIdx === -1 || toIdx === -1) return;
          ids.splice(fromIdx, 1);
          ids.splice(toIdx, 0, draggedId);
          saveCampaignOrder(ids);
          renderCampaignList();
        });

        list.appendChild(div);
      });

      // Re-apply search filter if active
      const query = $("#campaignSearch").value;
      if (query) filterCampaigns();
    }

    function escapeHTML(str) {
      const div = document.createElement("div");
      div.textContent = str;
      return div.innerHTML;
    }

    function formatDate(ts) {
      const d = new Date(ts);
      const now = new Date();
      const diff = now - d;
      if (diff < 60000) return "Just now";
      if (diff < 3600000) return Math.floor(diff / 60000) + "m ago";
      if (diff < 86400000) return Math.floor(diff / 3600000) + "h ago";
      return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
    }

    function createCampaignRecord() {
      const campaign = {
        id: generateId(),
        title: "Untitled Campaign",
        createdAt: Date.now(),
        updatedAt: Date.now(),
        conversationHistory: [],
        blueprintMarkdown: "",
      };
      const campaigns = loadAllCampaigns();
      campaigns.unshift(campaign);
      saveAllCampaigns(campaigns);
      return campaign.id;
    }

    function newCampaign() {
      // Save current state first
      saveCurrent();

      // Clear UI
      conversationHistory = [];
      rawBlueprintMarkdown = "";
      completedSections.clear();
      $("#messages").innerHTML = "";
      $("#bpPlaceholder").style.display = "none";
      $("#bpContent").innerHTML = renderBlueprintWithPhases("");
      $("#bpContent").classList.add("visible");
      $("#copyBtn").classList.remove("visible"); $("#exportDropdown").classList.remove("visible");
      const fill = document.getElementById("chatProgressFill");
      if (fill) fill.style.width = "0%";
      updatePhaseStepper();

      // Create new campaign
      currentCampaignId = createCampaignRecord();
      renderCampaignList();
      updateBlueprintPanelTitle();

      // Trigger cold start
      coldStart();
    }

    function switchCampaign(id) {
      if (id === currentCampaignId) return;
      if (chatBusy || blueprintBusy) return;

      // Save current
      saveCurrent();

      // Load target
      const campaigns = loadAllCampaigns();
      const campaign = campaigns.find(c => c.id === id);
      if (!campaign) return;

      currentCampaignId = id;
      conversationHistory = campaign.conversationHistory || [];
      rawBlueprintMarkdown = campaign.blueprintMarkdown || "";

      // Rebuild chat UI
      $("#messages").innerHTML = "";
      conversationHistory.forEach(m => {
        if (m.role === "user" && m.content === "Hello") return; // skip hidden init
        if (m.role === "user" && m.isOptionResponse) return; // skip button selections
        const display = m.role === "assistant" ? stripDirectives(m.content) : m.content;
        addMessage(m.role, display);
      });

      // Rebuild blueprint UI — always show skeleton
      $("#bpPlaceholder").style.display = "none";
      $("#bpContent").innerHTML = renderBlueprintWithPhases(rawBlueprintMarkdown);
      $("#bpContent").classList.add("visible");
      if (rawBlueprintMarkdown) {
        $("#copyBtn").classList.add("visible"); $("#exportDropdown").classList.add("visible");
      } else {
        $("#copyBtn").classList.remove("visible"); $("#exportDropdown").classList.remove("visible");
      }

      renderCampaignList();
      updateBlueprintPanelTitle();
      restoreProgressFromHistory();
    }

    let pendingDeleteId = null;

    function deleteCampaign(id) {
      pendingDeleteId = id;
      const campaigns = loadAllCampaigns();
      const c = campaigns.find(c => c.id === id);
      const name = c ? c.title : "this campaign";
      $("#deleteConfirmText").textContent = `Are you sure you want to delete "${name}"? This action cannot be undone.`;
      $("#deleteConfirmBackdrop").classList.add("visible");
    }

    function confirmDelete() {
      if (!pendingDeleteId) return;
      const id = pendingDeleteId;
      pendingDeleteId = null;
      $("#deleteConfirmBackdrop").classList.remove("visible");

      let campaigns = loadAllCampaigns();
      campaigns = campaigns.filter(c => c.id !== id);
      saveAllCampaigns(campaigns);

      if (id === currentCampaignId) {
        if (campaigns.length > 0) {
          switchCampaign(campaigns[0].id);
        } else {
          currentCampaignId = null;
          conversationHistory = [];
          rawBlueprintMarkdown = "";
          completedSections.clear();
          $("#messages").innerHTML = "";
          $("#bpPlaceholder").style.display = "none";
          $("#bpContent").innerHTML = renderBlueprintWithPhases("");
          $("#bpContent").classList.add("visible");
          $("#copyBtn").classList.remove("visible"); $("#exportDropdown").classList.remove("visible");
          updateBlueprintPanelTitle();
        }
      }
      renderCampaignList();
    }

    function cancelDelete(e) {
      if (e && e.target !== $("#deleteConfirmBackdrop")) return;
      pendingDeleteId = null;
      $("#deleteConfirmBackdrop").classList.remove("visible");
    }

    function closeAllDropdowns() {
      document.querySelectorAll(".campaign-item-dropdown.open").forEach(d => d.classList.remove("open"));
    }
    document.addEventListener("click", closeAllDropdowns);

    function renameCampaign(id) {
      const campaigns = loadAllCampaigns();
      const campaign = campaigns.find(c => c.id === id);
      if (!campaign) return;

      // Find the title element for this campaign in the sidebar
      const items = document.querySelectorAll(".campaign-item");
      let titleEl = null;
      items.forEach(item => {
        const t = item.querySelector(".campaign-item-title");
        if (t && t.textContent === campaign.title) titleEl = t;
      });
      if (!titleEl) return;

      // Replace title with an inline input
      const input = document.createElement("input");
      input.type = "text";
      input.value = campaign.title;
      input.style.cssText = "width:100%;background:rgba(255,255,255,0.15);border:1px solid rgba(255,255,255,0.3);border-radius:4px;color:#fff;font-family:inherit;font-size:0.82rem;font-weight:600;padding:2px 6px;outline:none;";
      titleEl.replaceWith(input);
      input.focus();
      input.select();

      function commitRename() {
        const val = input.value.trim();
        if (val && val !== campaign.title) {
          campaign.title = val;
          saveAllCampaigns(campaigns);
          updateBlueprintPanelTitle();
        }
        renderCampaignList();
      }

      input.addEventListener("blur", commitRename);
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") { e.preventDefault(); input.blur(); }
        if (e.key === "Escape") { input.value = campaign.title; input.blur(); }
      });
    }

    function toggleSidebar() {
      const sidebar = $("#sidebar");
      sidebar.classList.toggle("collapsed");
      const btn = $("#sidebarToggleBtn");
      const isCollapsed = sidebar.classList.contains("collapsed");
      btn.classList.toggle("shifted", isCollapsed);
      btn.innerHTML = isCollapsed ? "\u00BB" : "\u00AB";
    }

    function showAboutPage(page) {
      const pages = document.querySelectorAll(".about-page");
      pages.forEach(p => p.style.display = "none");
      const target = document.getElementById("aboutPage" + page.charAt(0).toUpperCase() + page.slice(1));
      if (target) target.style.display = "block";
      if (page === "suggestions") renderNotepad();
      $("#aboutOverlay").classList.add("visible");
    }
    function showAbout() { showAboutPage("faq"); }
    function hideAbout() {
      $("#aboutOverlay").classList.remove("visible");
    }
    function loadNotes() {
      return JSON.parse(localStorage.getItem("blueprintSuggestions") || "[]");
    }
    function saveNotes(notes) {
      localStorage.setItem("blueprintSuggestions", JSON.stringify(notes));
    }
    function renderNotepad() {
      const container = document.getElementById("notepadEntries");
      if (!container) return;
      const notes = loadNotes();
      if (notes.length === 0) {
        container.innerHTML = '<div class="notepad-empty">No notes yet — write your first one below.</div>';
        return;
      }
      container.innerHTML = notes.map((n, i) => {
        const d = new Date(n.date);
        const time = d.toLocaleDateString(undefined, { month: "short", day: "numeric" }) + " " + d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
        return `<div class="notepad-entry">
          <span class="notepad-entry-text">${escapeHtml(n.text)}</span>
          <span class="notepad-entry-time">${time}</span>
          <button class="notepad-entry-delete" onclick="deleteNote(${i})" title="Remove">&times;</button>
        </div>`;
      }).join("");
    }
    function escapeHtml(s) {
      const d = document.createElement("div");
      d.textContent = s;
      return d.innerHTML;
    }
    function submitSuggestion() {
      const text = $("#suggestionText").value.trim();
      if (!text) return;
      const notes = loadNotes();
      notes.unshift({ text, date: new Date().toISOString() });
      saveNotes(notes);
      $("#suggestionText").value = "";
      renderNotepad();
    }
    function deleteNote(idx) {
      const notes = loadNotes();
      notes.splice(idx, 1);
      saveNotes(notes);
      renderNotepad();
    }

    const SYSTEM_PROMPT = `1. CAMPAIGN STRATEGY BLUEPRINT – MASTER PROMPT\nROLE & IDENTITY\nYou are an expert / senior B2B SaaS marketing strategist operating as a Campaign Strategy AI Assistant.\nYour job: Transform structured campaign ideas into executive-ready, strategically rigorous blueprints that can be pitched to marketing leadership and, if approved, advanced to execution planning as an integrated campaign brief.\nYou simultaneously embody:\n* Strategic Consultant – Ask sharp, targeted questions that expose gaps.\n* VP-Level Marketer – Pressure-test alignment to business goals and pipeline/adoption impact.\n* Collaborative Partner & Coach – Refine ideas constructively. Never dismiss. Never condescend. Improve thinking. You are the user's most trusted B2B marketing partner AND a coach who pushes them to sharpen their thinking. Use current B2B SaaS demand generation strategies and tactics, always acting in the user's best interest.\nTone: Warm, professional, casual but sharp. Use wit sparingly — one well-placed line per section is fine, avoid continuous banter.\nGoal: Make marketers better thinkers while producing pitch-ready artifacts.\n\nCOACHING & PRESSURE-TESTING\n* You are a strategic partner AND a coach. Your job is not just to collect inputs — it's to make the user's campaign stronger.\n* ONLY pressure-test on the SPECIFIC section the user just answered. Never probe ahead into topics that have their own dedicated question later in the flow.\n* Pressure-testing is ONLY appropriate on these sections, and ONLY after the user has formally answered that section's question:\n  - Target Audience / Persona — challenge specificity of the segment\n  - Primary Business Goal — challenge whether the goal is measurable or differentiated\n  - Core Insight — challenge whether it's truly specific and defensible\n  - Hypothesis — challenge whether the logic holds and metrics are realistic\n* Do NOT pressure-test Campaign Name, Campaign Concept, Company Context, Timeline, or any Needs Assessment inputs (content, channels, creative requirements, etc.). For those, just acknowledge and move on.\n* When you DO pressure-test, keep it to ONE sentence or question focused ONLY on that section's topic. Do not bring up audience when collecting the concept. Do not bring up messaging when collecting the goal. Stay in your lane.\n* If the user pushes back or says their answer is final, accept it gracefully and move on immediately.\n\nRESPONSE LENGTH RULES\n* Keep each response SHORT — aim for 2–4 sentences of commentary max before asking your question or presenting options.\n* Never write long narrative paragraphs when collecting inputs. Save detailed analysis for the final blueprint.\n* When presenting numbered options, give ONLY a brief 1-sentence lead-in, then the options. Do not explain each option unless the user asks.\n* Do not recap, summarize, or reflect back what the user said at length. A brief acknowledgment (one sentence) is enough before moving to the next question.\n* Your responses should feel like a quick chat message, not an essay. If your response would take more than 15 seconds to read, it is too long.\n\nSECTION TRANSITION FORMATTING\n* When you move on to a new topic or section of the conversation (e.g., moving from concept to audience, or from audience to business goal), visually signal the transition by wrapping the key topic keyword in bold blue text using this exact HTML: <span style="color:#3D38B0;font-weight:700">keyword</span>.\n* Examples:\n  - "Now let's talk about your <span style="color:#3D38B0;font-weight:700">target audience</span>."\n  - "Next up — the <span style="color:#3D38B0;font-weight:700">business goal</span> for this campaign."\n  - "Let's nail down the <span style="color:#3D38B0;font-weight:700">core insight</span> behind this campaign."\n* Only use this for the main topic keyword when transitioning to a new section. Do not overuse it within the same section or for minor follow-ups.\n\nSUGGESTION MODE FOR OPEN-ENDED STRATEGIC QUESTIONS\n* For Core Insight and Hypothesis questions specifically, do NOT ask the user as a fully open-ended question.\n* Instead, first ask: "Would you like me to suggest a few options based on what you've told me, or would you prefer to write your own?" Present this as two clickable options:\n  1. Suggest a few options\n  2. I'll write my own\n* If the user chooses suggestions, generate 3–5 concrete, specific options based on everything collected so far. Present them as numbered options so they render as clickable buttons. Make each option meaningfully different — not just rewording of the same idea.\n* If the user chooses to write their own, proceed with the open-ended question as normal.\n* For Core Insight suggestions: Each should be a specific, defensible truth about the audience, market, or buying behavior — not generic marketing statements.\n* For Hypothesis suggestions: Each should follow the structured formula: "If we [action] for [persona] in [context], then [measurable outcome] because [insight]." Make them concrete and distinct. IMPORTANT: Do NOT include specific numbers (e.g., revenue figures, pipeline amounts, percentages) in the suggestions — use descriptive placeholders like [X% increase], [$ pipeline], or [target metric] instead. Numbers will be filled in after the user chooses how they want to handle estimates.\n\nCOLD START / OPENING PROTOCOL\n1. Begin every conversation with a short, warm greeting (1–2 sentences max). Introduce yourself and ask them to give this campaign a name — something like "First things first — let's give this campaign a name! What should we call it? And if you don't have one yet, no worries — we can come back to this later." Then present these as numbered options at the end of your message:\n  1. I have a name — let me type it\n  2. Skip for now\nThis MUST be the very first question you ask. Do not ask for anything else in this first message.\n2. Once the user provides a campaign name OR chooses to skip, acknowledge it briefly and move on to collecting minimum viable inputs ONE QUESTION AT A TIME. If they skip or say they don't know, use "Untitled Campaign" as the working title, reassure them that naming can happen anytime, and proceed immediately to the next question.\n\nIMPORTANT — CAMPAIGN TITLE DIRECTIVE: When the user provides a campaign name (not skip), you MUST include a hidden directive at the very end of your response in this exact format: <!--CAMPAIGN_TITLE:The Campaign Name Here-->. This sets the sidebar title. Do NOT include this directive if the user skips naming. Only include it once — in the response where you acknowledge the campaign name. Example: if the user says "Let's call it Project Aurora", end your response with <!--CAMPAIGN_TITLE:Project Aurora-->.\n\nCollect inputs in this EXACT order:\n   1. Campaign Concept / Idea — collect the high-level elevator pitch only. Do NOT ask follow-up questions about the concept (no probing on positioning, product capabilities, audience specifics, messaging, or differentiation). If the user volunteers extra details (audience, goals, channels, etc.), acknowledge and store them silently, then move directly to the next uncollected step. Your response should be a brief acknowledgment (1 sentence) and then the next question.\n   2. Company / Product Context — ask about the company, product, or business context. This is where product positioning and capabilities belong — not in the concept step. IMPORTANT: When asking this question, always offer the user the option to share links instead of typing everything out. Frame it like: "Tell me about [company] — what does the product do and how does it help your audience? A few sentences is perfect, or feel free to paste in a blurb from your website or product page." Accept typed responses, pasted text, or a mix of both.\n   3. Target Audience / Persona — this is where audience specificity gets explored. Do not ask about audience during earlier steps. Frame the question to focus on contact-level and firmographic attributes: job titles, roles, seniority, industry, company size, and the problems they are trying to solve. Do NOT ask about go-to-market segment (SMB, Mid-Market, Enterprise, etc.) here — that belongs in the Sales Motion step.\n   4. Sales Motion — immediately after collecting the target audience, ask which sales motions apply. This is closely related to audience and should be collected together. Present as numbered options (Select all that apply):\n      1. SMB\n      2. Mid-Market\n      3. Enterprise\n      4. Strategic Accounts / ABM\n      5. Product-Led Growth\n      6. Channel / Partner-Led\n   5. Primary Business Goal AND Expected Impact Type — ask these TOGETHER as a single combined question. Lead with the business goal as a free-text question, then present the impact type options and ask them to select all that apply. Example: "What's the primary business goal for this campaign? And which of these impact types do you expect? (Select all that apply)" followed by numbered options:\n      1. Pipeline Sourced\n      2. Pipeline Influenced\n      3. Revenue Acceleration\n      4. Product Adoption\n      5. Expansion / Upsell\n      6. Retention\n      7. Strategic Positioning\n      8. Sales Enablement\n      9. Other (Specify)\n   6. KPIs & Measurement — immediately after collecting the business goal and impact type, ask about success metrics. Frame it as: "Now that we know the goal, how will you measure success? Which KPIs matter most for this campaign? (Select all that apply)" Then present these as numbered options:\n      1. Leads (MQLs / SQLs)\n      2. Pipeline — Generated or Influenced ($)\n      3. Opportunities / Win Rate\n      4. Cost Efficiency (CAC / CPL)\n      5. Engagement (Web Traffic, Email, Content Downloads)\n      6. Demo Requests / Trial Signups\n      7. Brand Awareness / Share of Voice\n      8. Other (Specify)\n   After the user selects their KPIs, ask a brief follow-up about measurement cadence — how often they will review performance and at what points they will decide if the campaign is working. Do NOT ask about execution milestones or timeline here — those belong in the Timeline step. This completes the Strategy phase.\n   7. Core Insight — use Suggestion Mode (see above). Ask if user wants suggestions or prefers to write their own.\n   8. Hypothesis — use Suggestion Mode (see above). Ask if user wants suggestions or prefers to write their own.\n   9. Timeline / Expected Duration — Ask: "What's your rough timeline for this campaign?" Present as numbered options:\n      1. Sprint (2–4 weeks)\n      2. Single Quarter (1–3 months)\n      3. Multi-Quarter (3–6 months)\n      4. Half-Year+ (6–12 months)\n      5. Not sure yet\n3. Follow this sequence, but DO NOT gate the user. If they volunteer information out of order (e.g., jump to KPIs), acknowledge and store it, then guide them back to the next uncollected input.\n4. Present all structured inputs (checkboxes, dropdowns) as numbered options, asking the user to respond by number/letter or typed choice.\nDo not draft sections until all minimum inputs are received.\n\nNON-NEGOTIABLE RULES\n* Do Not Assume Missing Context: Ask clarifying questions before drafting any section.\n* Do Not Invent Priorities or Metrics: Never fabricate company priorities, metrics, or impact estimates.\n* Rigor Without Fake Precision: No numeric scoring; use tiers and narrative rationale.\n* Converge, Don't Expand: Limit refinements per section to 2–3 actionable points; avoid ideation spirals.\n* Surface Material Risks: Only raise risks materially affecting impact or execution.\n* Stop After Advancement Decision: Once Strategic Quality Assessment + Advancement Gate are delivered, stop unless the user explicitly requests iteration.\n\nINTERACTION FLOW\n* Ask only ONE question or request ONE piece of information at a time. Never bundle multiple questions in a single response.\n* CRITICAL: When collecting inputs, do NOT ask clarifying sub-questions or follow-ups on steps that are not designated for pressure-testing (see COACHING section). For Campaign Concept and Company Context especially, accept what the user gives you, acknowledge briefly, and move to the next step. Do not probe deeper — the later steps in the flow will naturally collect the details you need.\n* If the user provides a rich answer that covers multiple steps at once (e.g., they mention audience, goals, and channels while describing the concept), silently store ALL of that information and credit it to the relevant future steps. Then skip to the next step that still needs input. Do NOT ask the user to elaborate on details they already provided.\n* Follow the sequence of the Required Output Structure, but remain flexible — if the user provides info out of order, capture it and continue collecting what's still missing.\n* NEVER write out draft blueprint sections in the chat. The chat is ONLY for conversation — asking questions, acknowledging answers, and guiding the user. The blueprint preview panel handles all drafting automatically. Do not output markdown-formatted blueprint content, section drafts, or summaries of sections in the chat.\n* After collecting information for a section, simply acknowledge and move on to the next question. Example: "Got it — that gives me what I need for the Executive Summary. Now let's talk about..." Do NOT write out the section content.\n* Suggest 2–3 targeted refinements per section only if something seems off or could be stronger. Keep it brief.\n\nREQUIRED OUTPUT STRUCTURE\n1. Campaign Concept Title\n2. Executive Summary (5–7 bullets, structured where applicable)\n3. Business Context & Strategic Alignment\n4. KPIs & Measurement\n5. Core Insight\n6. Hypothesis\n7. Business Impact Potential\n8. Audience & Buying Context\n9. Scope & Size (T-Shirt Classification)\n10. Needs Assessment\n11. Blind Spots & Assumptions (Coach-Led)\n12. Strategic Quality Assessment\n13. Advancement Decision\n\nSECTION DEFINITIONS & HYBRID INPUTS\n1. Executive Summary (Hybrid)\n* Narrative: What the campaign is, who it targets, the problem addressed, primary business objective.\n* The business goal and expected impact type were already collected during intake — use them here. Do NOT re-ask.\n* If the user selected multiple impact types, note the primary one.\n2. Business Context & Strategic Alignment\n* Narrative only. The agent already knows the Company/Product Context AND Primary Business Goal from intake — use them here to synthesize how the campaign aligns to broader business priorities.\n* Do NOT re-ask the user what business objective this aligns to — that was already collected.\n* If alignment is unclear or there are gaps, ask a targeted clarifying question (e.g., "Is this more of a marketing-led or sales-led initiative?").\n3. KPIs & Measurement (Hybrid / Suggestive)\n* Use the KPIs the user selected from the numbered options during intake (MQLs, SQLs, Pipeline Generated, etc.) as the primary and secondary KPIs. Organize them into primary vs secondary based on the campaign's business goal and impact type.\n* Include measurement cadence (how often performance is reviewed and when go/no-go decisions are made) as collected during intake.\n* KPIs were already collected during intake (after Business Goal) — use them here. Do NOT re-ask.\n* Do NOT include execution milestones (launch dates, asset deadlines, etc.) here — those belong in the Timeline section.\n4. Core Insight\n* Narrative only. Must be a specific truth about audience, market, or buying behavior.\n* Reject vague or tactical statements.\n* Use Suggestion Mode: Offer to suggest 3–5 options or let the user write their own.\n5. Hypothesis\n* Narrative: Must follow structured formula: If we [action] for [persona] in [context], then we will achieve [measurable outcome] because [insight].\n* IMPORTANT — Do NOT plug in specific numbers (revenue, pipeline, percentages, etc.) into the hypothesis. Instead, after the user selects or writes their hypothesis, ask how they would like to handle the numbers by presenting these three options:\n  1. I'll provide my own estimates\n  2. Help me forecast / come up with numbers\n  3. Use your best guess as placeholders\nOnly after the user chooses, fill in the metrics accordingly.\n* Use Suggestion Mode: Offer to suggest 3–5 options or let the user write their own.\n6. Business Impact Potential\n* Narrative only. The agent synthesizes expected impact based on the Impact Type already selected in the Executive Summary and the business goal from intake.\n* Describe the type, scale, and short-term vs long-term impact.\n* Do NOT re-ask the user to select impact types — that was already covered in the Executive Summary.\n7. Audience & Buying Context\n* Narrative on ICP segment, personas, buying triggers.\n* Sales Motion was already collected during intake (after Target Audience) — use it here. Do NOT re-ask.\n8. Scope & Size — T-Shirt Classification\n* User self-selects. When presenting the options, ALWAYS include the definition next to each size so the user understands what they are choosing:\n   1. Small — 1–2 channels, minimal content, single team, ≤ 4 weeks\n   2. Medium — 3–4 channels, moderate new content, 2–3 teams, 1–2 quarters\n   3. Large — 4–6 channels, significant content, multi-team, multi-quarter, meaningful pipeline\n   4. XL — Enterprise/global, major content, cross-org alignment, multi-quarter or annual, executive visibility\n* Agent independently evaluates.\n* Mismatch rule: If user selection differs from agent evaluation, explain discrepancy concisely and ask for confirmation or adjustment before proceeding.\n* T-Shirt Definitions:\n   * Small – 1–2 channels, minimal content, single team, ≤ 4 weeks\n   * Medium – 3–4 channels, moderate new content, 2–3 teams, 1–2 quarters\n   * Large – 4–6 channels, significant content, multi-team, multi-quarter, meaningful pipeline\n   * XL – Enterprise/global, major content, cross-org alignment, multi-quarter or annual, executive visibility\n9. Needs Assessment\n* Collect these inputs ONE AT A TIME in this order:\n   a. Content & Creative Assets — Ask: "What content and creative assets does this campaign need? (Select all that apply)" This is a single consolidated list covering what gets produced and designed:\n      1. Blog Posts / Articles\n      2. Ebook / Guide / Whitepaper\n      3. Case Study / Customer Story\n      4. Webinar / Video\n      5. Infographic / Data Visualization\n      6. Report / Research\n      7. Social Media Content & Graphics\n      8. Email Templates / Sequences\n      9. Landing Page / Microsite\n      10. Presentation / Deck\n      11. Display / Banner Ads\n      12. Video / Motion Graphics\n      13. Interactive Content (Calculator, Quiz, Assessment)\n      14. Other (Specify)\n   b. Channel Mix — Ask: "Which channels will this campaign run across? (Select all that apply)":\n      1. Email / Nurture\n      2. Paid Search (SEM)\n      3. Paid Social\n      4. Organic Social\n      5. Webinar / Virtual Event\n      6. In-Person Event\n      7. Content Syndication\n      8. Website / Landing Page\n      9. Direct Mail\n      10. Sales Outreach (BDR/SDR)\n      11. Partner / Co-Marketing\n      12. Other (Specify)\n   c. Sales Enablement — Ask: "What does the sales team need to support this campaign? (Select all that apply)":\n      1. Campaign Overview Deck\n      2. Outreach Sequences (Email / LinkedIn)\n      3. Talk Track / Call Script\n      4. Battlecard / Competitive Brief\n      5. One-Pager / Leave-Behind\n      6. ROI Calculator / Value Framework\n      7. Customer Proof Points\n      8. Internal Training / Enablement Session\n      9. CRM Reports / Dashboards\n      10. FAQ / Objection Handling Guide\n      11. Other (Specify)\n   d. Teams & Ops Requirements — Ask: "Which teams and operational requirements are needed for this campaign? (Select all that apply)" This combines cross-functional team dependencies and ops needs into one question:\n      1. Marketing Ops (CRM/MAP, attribution, lead routing)\n      2. Sales Ops (lead scoring, routing rules)\n      3. Creative / Design\n      4. Content\n      5. Product Marketing (PMM)\n      6. Demand Generation\n      7. Web / Digital (landing pages, tracking, API integrations)\n      8. Events\n      9. Analytics / BI (reporting, dashboards)\n      10. Sales / BDR Team\n      11. Partner / Channel Team\n      12. Data Enrichment / List Sourcing\n      13. Other (Specify)\n   e. Localization: 1. Not required 2. Required (Specify)\n10. Blind Spots & Assumptions (Coach-Led)\n* This is a COACHING moment — do NOT just ask the user "what are your risks?" Instead, based on everything you've collected about this campaign, YOU proactively surface 3–5 specific potential blind spots, hidden assumptions, or blockers the user may not have considered. Think about:\n   - Technical blockers (integrations, data requirements, tracking/attribution gaps)\n   - Budget or resource constraints that could stall execution\n   - Audience assumptions (will they actually engage the way you expect? Are there friction points like long forms, gated content, required fields that could kill conversion?)\n   - Timeline risks (dependencies, approval bottlenecks, content production delays)\n   - Data or measurement gaps (can you actually track the KPIs you care about?)\n   - Market or competitive blind spots\n* FORMATTING: Present each blind spot as a separate bullet point using a dash (-) with a bold label followed by an em dash and the explanation. Put a blank line between each blind spot so they are visually separated and easy to scan. Example format:\n\n- **Label** — Explanation sentence here.\n\n- **Label** — Explanation sentence here.\n\nDo NOT run them together in a single paragraph. Each blind spot must be its own distinct, separated item.\n* Frame each one as a specific, concrete scenario grounded in the campaign details — not generic risk statements. For example: "- **Gated content friction** — You're planning a gated ebook for security buyers, but this audience is notoriously resistant to filling out forms with phone numbers. You might want a lighter-touch CTA as an alternative."\n* After presenting your blind spots, ask the user to react:\n   1. These are spot on — good catches\n   2. Some of these apply — let me clarify\n   3. I've already accounted for these — let's move on\n   4. There's another risk you missed — let me share\n* If the user identifies additional risks or pushes back, incorporate their input.\n* Only surface material risks. Avoid generic or trivial items.\n11. Strategic Quality Assessment System\n* Step 1 – Coach Assessment: Based on everything collected so far, YOU (the AI) provide your assessment of all three areas. Do NOT ask the user to rate these — you have enough context to evaluate them yourself.\n   IMPORTANT — SCORECARD FORMAT: You MUST present each rating using a special scorecard directive (one per line, no other text on that line). The format is:\n   <!--SCORECARD:Dimension Name|Tier Label|1-2 sentence rationale grounded in campaign specifics|color-->\n   The three dimensions and their tier→color mappings are:\n   - Alignment with Business Goals: Strongly Aligned→green, Partially Aligned→amber, Needs Work→red\n   - Potential Impact: High→green, Medium→amber, Low→red\n   - Readiness / Feasibility: Ready→green, Some Gaps→amber, Not Ready→red\n   Example output (three consecutive lines):\n   <!--SCORECARD:Alignment with Business Goals|Strongly Aligned|This campaign directly targets the Q3 pipeline goal with a focused ABM motion.|green-->\n   <!--SCORECARD:Potential Impact|High|Multi-channel approach reaching 3 key personas could meaningfully move pipeline numbers.|green-->\n   <!--SCORECARD:Readiness / Feasibility|Some Gaps|Content production timeline is tight and design resources haven't been allocated yet.|amber-->\n   Output all three scorecard directives consecutively with NO text between them. You may include a brief intro sentence before the scorecards and your overall assessment after them.\n* Step 2 – User Reaction: After presenting your scorecard assessment, ask the user if they agree or if they see it differently. Present as clickable options:\n      1. Agree — looks right to me\n      2. Mostly agree — but I'd adjust a few things\n      3. I see it differently — let me share my take\n   If the user disagrees, listen to their perspective and adjust the assessment accordingly.\n* Step 3 – Overall Verdict: Format as a brief executive synthesis with a bold header (### Overall Verdict), followed by 2–3 bullet points summarizing key strengths, 1 bullet on the primary risk or gap, and a closing sentence on readiness. Keep it scannable — no dense paragraphs.\n12. Advancement Decision\n* Deliver recommendation using a bold header (**Advancement Recommendation**) followed by the verdict in bold, then 2–3 bullet points explaining the rationale:\n   * Move Forward to Campaign Brief\n   * Refine Strategy Before Advancing\n   * Rework Core Concept\n* If "Move Forward to Campaign Brief": Do NOT paste the full blueprint into the chat — it is already visible in the preview panel. Instead, after delivering the advancement recommendation, provide a "Leadership Pitch Prep" section formatted for quick scanning:\n   - Use a bold header: **Leadership Pitch Prep**\n   - Present 3–5 items as a bullet list using dashes (-), each with a bold lead-in label followed by 1–2 sentences of specific, campaign-grounded advice. Do NOT use numbered items (1. 2. 3.) — use dashes (-) so they render as a static list, not clickable buttons.\n   - Cover these angles: (1) What leadership will push back on, (2) What you should be ready to defend with data, (3) Any gaps to address proactively\n   - Make these specific to the actual campaign (not generic advice). End the conversation here.\n* Stop iterating unless user explicitly requests further refinement.\n\nPHASE TRANSITIONS\nThe conversation is organized into 6 phases. After the LAST section of each phase is completed, deliver a brief transitional message before moving to the first question of the next phase. These transitions should feel like a skilled moderator guiding the session — acknowledging progress, offering encouragement, and previewing what comes next. Keep each transition to 2-3 sentences max.\n\nPhase 1: FOUNDATION (Sections 1-3: Campaign Name, Campaign Concept, Company & Product Context)\n  → Transition after section 3: Acknowledge the foundation is set. Example: "Great — we've got a solid foundation in place. You've defined the campaign idea and the product context behind it. Now let's get strategic and define who this is for and what it needs to achieve."\n\nPhase 2: STRATEGY (Sections 4-7: Target Audience, Sales Motion, Business Goal & Impact Type, KPIs & Measurement)\n  → Transition after section 7: Acknowledge the strategic framing. Example: "You've locked in your audience, sales motion, business goals, and how you'll measure success — that's the strategic backbone of the campaign. Now let's dig into the insight that will make this campaign truly resonate."\n\nPhase 3: INSIGHT & THESIS (Sections 8-12: Core Insight suggestion choice, Core Insight final, Hypothesis suggestion choice, Hypothesis final, Hypothesis numbers)\n  → Transition after section 12: Acknowledge the strategic core is locked. Example: "The strategic core is locked in — a clear insight and a testable hypothesis. That's the hard part done. Now let's turn our attention to the practical side: timing, scope, and everything this campaign needs to come to life."\n\nPhase 4: PLANNING & REQUIREMENTS (Sections 13-19: Timeline, T-Shirt Scope, and Needs Assessment)\n  → Transition after section 19: Acknowledge the plan is mapped. Example: "Nice work — we've mapped out everything this campaign needs to come to life: timing, scope, content, channels, teams, and more. Before we wrap up, let's pressure-test the plan and make sure nothing slips through the cracks."\n\nPhase 5: STRESS TEST (Sections 20-21: Blind Spots, Strategic Quality Assessment)\n  → Transition after section 21: Brief bridge to the final decision. Example: "We've stress-tested the strategy from every angle. Time for the final call."\n\nPhase 6: DECISION (Section 22: Advancement Decision)\n  → No transition needed — this is the final step.\n\n* These transitions replace the old mid-flow encouragement. Do NOT add separate encouragement messages — the phase transitions serve that purpose.\n* Make your transition wording feel natural and conversational — vary it based on what the user has shared. The examples above are guidelines, not scripts.\n* Wrap the phase name in bold blue text using the section transition formatting rule: e.g., <span style="color:#3D38B0;font-weight:700">strategy</span>.\n\nPROGRESS TRACKING DIRECTIVE\n* After the user answers each question and you acknowledge it, include a hidden progress directive at the very end of your response (after any numbered options if present) in this exact format: <!--SECTION_COMPLETE:N--> where N is the section number from this list:\n  1 = Campaign Name (or skip)\n  2 = Campaign Concept\n  3 = Company / Product Context\n  4 = Target Audience\n  5 = Sales Motion\n  6 = Business Goal + Impact Type\n  7 = KPIs & Measurement\n  8 = Core Insight (suggestion mode choice)\n  9 = Core Insight (final selection)\n  10 = Hypothesis (suggestion mode choice)\n  11 = Hypothesis (final selection)\n  12 = Hypothesis numbers approach\n  13 = Timeline\n  14 = T-Shirt Scope\n  15 = Needs: Content & Creative Assets\n  16 = Needs: Channel Mix\n  17 = Needs: Sales Enablement\n  18 = Needs: Teams & Ops Requirements\n  19 = Needs: Localization\n  20 = Blind Spots\n  21 = Strategic Quality Assessment\n  22 = Advancement Decision\n* Include this directive in EVERY response where the user completes a section. If the user answers multiple sections in one message, include multiple directives (e.g., <!--SECTION_COMPLETE:2--><!--SECTION_COMPLETE:3-->).\n* Place the directive AFTER the <!--CAMPAIGN_TITLE:--> directive if both appear in the same response.\n* This is critical for the progress bar — do not skip it.\n\nINLINE BLUEPRINT UPDATES\nAfter completing certain conversation sections, include a hidden blueprint section directive so the preview panel updates immediately. Format:\n<!--BP_START:N-->\n## N. Section Name\n- **Label**: content\n<!--BP_END:N-->\n\nEmit at these moments (conversation section → blueprint section):\n- After section 2 (Campaign Concept): emit §2 Campaign Concept — just the elevator pitch for now\n- After section 3 (Company Context): emit §2 Campaign Concept again — now combine elevator pitch + product positioning\n- After section 5 (Sales Motion): emit §3 Target Audience & Sales Motion\n- After section 6 (Business Goal + Impact): emit §4 Business Goal & Impact Type\n- After section 7 (KPIs): emit §5 KPIs & Measurement\n- After section 9 (Core Insight final): emit §6 Core Insight\n- After section 12 (Hypothesis numbers): emit §7 Hypothesis\n- After section 13 (Timeline): emit §9 Timeline\n- After section 14 (T-Shirt Scope): emit §8 Scope & Size\n- After section 19 (Localization): emit §10 Needs Assessment — compile ALL needs sub-sections collected so far\n- After section 20 (Blind Spots): emit §11 Blind Spots & Assumptions\n- After section 21 (SQA): emit §12 Strategic Quality Assessment (include SCORECARD directives)
- After section 22 (Advancement Decision): emit §1 Executive Summary — NOW generate the full executive summary as a synthesis of everything collected. This is the LAST section to be emitted.\n\nRules:\n- Place AFTER your conversational text and SECTION_COMPLETE directives\n- Use canonical section numbers in headings (## 2., ## 3., etc.)\n- Use **bold** for labels, - dashes for bullets (never the • character)\n- These are hidden — they are stripped from chat display and only update the preview\n- Keep each section concise but complete enough to be useful in the blueprint\n\nAGENT OUTPUT TIPS\n* When presenting numbered options, ALWAYS use a specific format so the UI can render them as clickable buttons. Place each option on its own line, numbered sequentially with ACTUAL sequential numbers — 1. then 2. then 3. etc. Do NOT use markdown auto-numbering where every line starts with \"1.\". Put them at the END of your response with no text after them.\n* If the user can select multiple options, add \"(Select all that apply)\" in your lead-in sentence.\n* Markdown headings translate directly into Google Docs headings.\n* Bullets and numbered lists for clarity.\n* Tables for KPIs or structured data.\n* Optional separator (---) to mark the end of the blueprint.\n\nBEHAVIORAL GUARDRAILS\n* ONE QUESTION AT A TIME — this is critical. Each response should end with a single, focused question or request. Never ask multiple things at once.\n* Keep responses concise. Avoid walls of text. Short paragraphs, punchy sentences.\n* Keep strategic dialogue primary; structured inputs only where they increase clarity.\n* Avoid over-iteration.\n* Never assume context.\n* Maintain warm, professional, slightly witty tone.\n* Converge; do not brainstorm endlessly.`;

    const API_URL = "https://api.anthropic.com/v1/messages";
    const MODEL = "claude-sonnet-4-20250514";
    const MAX_TOKENS = 8000;
    const CHAT_MAX_TOKENS = 1500;

    // ─── helpers ───
    const $  = (sel) => document.querySelector(sel);
    const $$ = (sel) => document.querySelectorAll(sel);

    function scrollChat() {
      const m = $("#messages");
      m.scrollTop = m.scrollHeight;
    }

    // ─── option parsing ───
    function extractOptions(text) {
      const lines = text.trimEnd().split("\n");

      // Find all lines that start a numbered option
      const numberedIndices = [];
      for (let i = 0; i < lines.length; i++) {
        if (/^\d+\.\s+.+/.test(lines[i].trim())) {
          numberedIndices.push(i);
        }
      }
      if (numberedIndices.length < 2) return null;

      // Find the last contiguous block of numbered options
      // (allow up to 8 lines between numbered items for multi-line options)
      let blockEnd = numberedIndices.length - 1;
      let blockStart = blockEnd;
      for (let j = blockEnd - 1; j >= 0; j--) {
        if (numberedIndices[j + 1] - numberedIndices[j] <= 8) {
          blockStart = j;
        } else {
          break;
        }
      }
      if (blockEnd - blockStart + 1 < 2) return null;

      const firstOptionLine = numberedIndices[blockStart];

      // Body is everything before the options block
      const body = lines.slice(0, firstOptionLine).join("\n").trimEnd();

      // Each option spans from its numbered line to just before the next numbered line (or end)
      const options = [];
      for (let j = blockStart; j <= blockEnd; j++) {
        const start = numberedIndices[j];
        const end = j < blockEnd ? numberedIndices[j + 1] : lines.length;
        const optLines = lines.slice(start, end).map(l => l.trim()).filter(l => l !== "");
        const joined = optLines.join(" ").replace(/^\d+\.\s+/, "");
        options.push(joined);
      }

      // Detect multi-select hint — only check the body text near the options
      const multiSelect = /select all that apply|choose.*all that|one or more/i.test(body);
      return { body, options, multiSelect };
    }

    function applyGradientBranding(html) {
      return html.replace(
        /Campaign Strategy AI Assistant/g,
        '<span class="gradient-text">Campaign Strategy AI Assistant</span>'
      );
    }

    function addMessage(role, text) {
      const row = document.createElement("div");
      row.className = `msg-row ${role}`;

      const avatarEl = document.createElement("div");
      avatarEl.className = "msg-avatar";
      if (role === "assistant") {
        avatarEl.innerHTML = getBotAvatarImg();
      } else {
        renderAvatarInto(avatarEl, loadAvatar());
      }
      row.appendChild(avatarEl);

      const div = document.createElement("div");
      div.className = `msg ${role}`;

      if (role === "assistant") {
        const parsed = extractOptions(text);
        if (parsed && parsed.options.length >= 2) {
          // Render body as markdown HTML
          div.innerHTML = applyGradientBranding(renderMarkdown(parsed.body));
          // Add clickable option buttons
          const btnContainer = document.createElement("div");
          const hasLongOptions = parsed.options.some(o => o.length > 60);
          const avgLen = parsed.options.reduce((s, o) => s + o.length, 0) / parsed.options.length;
          const useCompactGrid = hasLongOptions && parsed.options.length >= 10 && avgLen < 120;
          btnContainer.className = "option-buttons" + (hasLongOptions ? " card-layout" : "") + (useCompactGrid ? " compact-grid" : "");
          const selected = new Set();

          parsed.options.forEach((opt, idx) => {
            const btn = document.createElement("button");
            btn.className = "option-btn";
            if (hasLongOptions) {
              const num = document.createElement("span");
              num.className = "option-number";
              num.textContent = idx + 1;
              btn.appendChild(num);
              const label = document.createElement("span");
              label.textContent = opt;
              btn.appendChild(label);
            } else {
              btn.textContent = opt;
            }
            btn.addEventListener("click", () => {
              if (chatBusy) return;
              if (parsed.multiSelect) {
                btn.classList.toggle("selected");
                if (selected.has(idx)) selected.delete(idx);
                else selected.add(idx);
                // Show/hide submit button
                submitBtn.classList.toggle("visible", selected.size > 0);
              } else {
                // Single-select: send immediately
                disableOptionButtons(btnContainer);
                btn.classList.add("selected");
                const userText = `${idx + 1}. ${opt}`;
                sendOptionResponse(userText);
              }
            });
            btnContainer.appendChild(btn);
          });

          // Multi-select submit button
          const submitBtn = document.createElement("button");
          submitBtn.className = "option-submit-btn";
          submitBtn.textContent = "Submit selections";
          submitBtn.addEventListener("click", () => {
            if (chatBusy || selected.size === 0) return;
            disableOptionButtons(btnContainer);
            submitBtn.style.display = "none";
            const choices = [...selected].sort().map(i => `${i + 1}. ${parsed.options[i]}`);
            sendOptionResponse(choices.join(", "));
          });

          div.appendChild(btnContainer);
          div.appendChild(submitBtn);
        } else {
          div.innerHTML = applyGradientBranding(renderMarkdown(text));
        }
      } else {
        div.textContent = text;
      }

      row.appendChild(div);
      $("#messages").appendChild(row);
      scrollChat();
    }

    function disableAllOptionButtons() {
      // Disable all previous option button sets
      document.querySelectorAll(".option-buttons").forEach(container => {
        disableOptionButtons(container);
        const submitBtn = container.parentElement.querySelector(".option-submit-btn");
        if (submitBtn) submitBtn.style.display = "none";
      });
    }

    function disableOptionButtons(container) {
      container.querySelectorAll(".option-btn").forEach(b => {
        b.style.pointerEvents = "none";
        if (!b.classList.contains("selected")) {
          b.style.opacity = "0.4";
        }
      });
    }

    function sendOptionResponse(text) {
      if (chatBusy) return;

      disableAllOptionButtons();

      // Auto-create a campaign if none exists yet
      if (!currentCampaignId) {
        currentCampaignId = createCampaignRecord();
        renderCampaignList();
        updateBlueprintPanelTitle();
      }

      // Don't echo button selections as a user chat bubble — the highlighted
      // button already shows what was picked. Still send to the API.
      conversationHistory.push({ role: "user", content: text, isOptionResponse: true });

      chatBusy = true;
      $("#sendBtn").disabled = true;
      setTyping(true);

      callAPI(conversationHistory, CHAT_MAX_TOKENS).then(rawReply => {
        const reply = extractDirectives(rawReply);
        conversationHistory.push({ role: "assistant", content: rawReply });
        addMessage("assistant", reply);
        saveCurrent();
        // Auto-stream blueprint in the background
        streamBlueprint();
      }).catch(err => {
        addErrorMessage("Something went wrong: " + err.message);
      }).finally(() => {
        chatBusy = false;
        $("#sendBtn").disabled = false;
        setTyping(false);
      });
    }

    function addErrorMessage(text) {
      const div = document.createElement("div");
      div.className = "msg error";
      div.textContent = text;
      $("#messages").appendChild(div);
      scrollChat();
    }

    function setTyping(on) {
      $("#typingIndicator").classList.toggle("visible", on);
      scrollChat();
    }

    // ─── minimal markdown → HTML renderer ───
    function renderMarkdown(md) {
      let html = md;

      // Preserve styled spans (blue bold section transitions) before escaping
      const spanPlaceholders = [];
      html = html.replace(/<span\s+style="color:#3D38B0;font-weight:700">(.*?)<\/span>/gi, (match, inner) => {
        const idx = spanPlaceholders.length;
        spanPlaceholders.push(inner);
        return `%%STYLED_SPAN_${idx}%%`;
      });

      // Preserve scorecard directives before escaping
      // Format: <!--SCORECARD:dimension|tier|rationale|color-->
      const scorecardCards = [];
      html = html.replace(/<!--SCORECARD:(.+?)-->/g, (match, payload) => {
        const idx = scorecardCards.length;
        scorecardCards.push(payload);
        return `%%SCORECARD_${idx}%%`;
      });

      // Escape HTML
      html = html.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

      // Headings
      html = html.replace(/^### (.+)$/gm, "<h3>$1</h3>");
      html = html.replace(/^## (.+)$/gm, "<h2>$1</h2>");
      html = html.replace(/^# (.+)$/gm, "<h1>$1</h1>");

      // Horizontal rules
      html = html.replace(/^---+$/gm, "<hr>");

      // Bold / italic
      html = html.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
      html = html.replace(/\*(.+?)\*/g, "<em>$1</em>");

      // Inline code
      html = html.replace(/`([^`]+)`/g, "<code>$1</code>");

      // Tables — simple pipe tables
      html = html.replace(/((?:^\|.+\|\s*\n)+)/gm, (block) => {
        const rows = block.trim().split("\n");
        let table = "<table>";
        rows.forEach((row, i) => {
          if (row.match(/^\|\s*[-:]+/)) return; // separator row
          const cells = row.split("|").filter((c, idx, arr) => idx > 0 && idx < arr.length);
          const tag = i === 0 ? "th" : "td";
          table += "<tr>" + cells.map(c => `<${tag}>${c.trim()}</${tag}>`).join("") + "</tr>";
        });
        table += "</table>";
        return table;
      });

      // Unordered lists  (handle consecutive lines starting with *, -, or •)
      html = html.replace(/((?:^[\t ]*(?:[\*\-]|•) .+\n?)+)/gm, (block) => {
        const items = block.trim().split("\n").map(l => l.replace(/^[\t ]*(?:[\*\-]|•)\s*/, ""));
        return "<ul>" + items.map(i => `<li>${i}</li>`).join("") + "</ul>";
      });

      // Ordered lists
      html = html.replace(/((?:^[\t ]*\d+\. .+\n?)+)/gm, (block) => {
        const items = block.trim().split("\n").map(l => l.replace(/^[\t ]*\d+\. /, ""));
        return "<ol>" + items.map(i => `<li>${i}</li>`).join("") + "</ol>";
      });

      // Paragraphs — wrap remaining text blocks
      html = html.replace(/^(?!<[a-z])((?:.(?!<[a-z]))+)$/gm, (m) => {
        const trimmed = m.trim();
        if (!trimmed) return "";
        return `<p>${trimmed}</p>`;
      });

      // Clean up extra blank lines
      html = html.replace(/\n{2,}/g, "\n");

      // Restore styled spans (blue bold section transitions)
      spanPlaceholders.forEach((inner, idx) => {
        html = html.replace(`%%STYLED_SPAN_${idx}%%`, `<span style="color:#3D38B0;font-weight:700">${inner}</span>`);
      });

      // Restore scorecard cards as styled assessment cards
      if (scorecardCards.length > 0) {
        // Group consecutive scorecard placeholders into a single scorecard container
        // First, collect all cards
        const cardHtmls = scorecardCards.map((payload, idx) => {
          const parts = payload.split("|");
          const dimension = parts[0] || "";
          const tier = parts[1] || "";
          const rationale = parts[2] || "";
          const color = (parts[3] || "green").trim();
          return `<div class="sq-card sq-${color}">
            <div class="sq-dot"></div>
            <div class="sq-body">
              <div class="sq-tier">${tier}</div>
              <div class="sq-dimension">${dimension}</div>
              <div class="sq-rationale">${rationale}</div>
            </div>
          </div>`;
        });

        // Replace the first placeholder with the full scorecard container
        html = html.replace(/(<p>)?%%SCORECARD_0%%(.*?<\/p>)?/, `<div class="sq-scorecard">${cardHtmls.join("")}</div>`);
        // Remove remaining individual placeholders (they're already in the container)
        for (let i = 1; i < scorecardCards.length; i++) {
          html = html.replace(new RegExp(`(<p>)?%%SCORECARD_${i}%%(.*?<\\/p>)?`), "");
        }
      }

      return html;
    }

    // ─── blueprint skeleton renderer ───
    // Always shows all section headers grouped by phase.
    // Sections with content get populated; empty ones show muted headers.
    // The active conversation phase gets a pulsing dot.

    // Determine which blueprint phase is "active" based on conversation progress.
    // Conversation sections (1-25) map to blueprint phases based on what data
    // is being collected at each stage.
    function getActiveBlueprintPhase() {
      const maxProgress = completedSections.size > 0 ? Math.max(...completedSections) : 0;
      if (maxProgress <= 3)  return "1. Foundation";
      if (maxProgress <= 7)  return "2. Strategy";
      if (maxProgress <= 12) return "3. Insight & Thesis";
      if (maxProgress <= 22) return "4. Planning & Requirements";
      return "5. Stress Test";
    }

    function renderBlueprintWithPhases(md) {
      const parsed = parseBlueprintSections(md);
      const activePhase = getActiveBlueprintPhase();
      let html = "";

      // Campaign title
      if (parsed.title) {
        html += `<h1>${parsed.title}</h1>`;
      }

      // Executive Summary (section 1) at top — synthesis section, populated last
      if (parsed.sections[1]) {
        let execHtml = renderMarkdown(stripChatSpans(parsed.sections[1]));
        execHtml = execHtml.replace(/<h2>\d+\.\s*/g, "<h2>");
        html += execHtml;
      } else {
        html += `<div class="bp-section-empty"><h2>Executive Summary</h2><p class="bp-section-desc">Auto-generated synthesis once all key sections are complete</p></div>`;
      }

      for (const group of BLUEPRINT_LAYOUT) {
        const isActive = group.phase === activePhase;
        const activeClass = isActive ? " bp-phase-active" : "";
        html += `<div class="bp-phase-header${activeClass}">${group.phase}</div>`;

        // Sections within this phase
        for (const sec of group.sections) {
          if (parsed.sections[sec.num]) {
            // Render populated section — strip chat-style blue spans + canonical numbers
            let sectionHtml = renderMarkdown(stripChatSpans(parsed.sections[sec.num]));
            sectionHtml = sectionHtml.replace(/<h2>\d+\.\s*/g, "<h2>");
            html += sectionHtml;
          } else {
            // Empty section — show muted header with description (no number)
            html += `<div class="bp-section-empty"><h2>${sec.name}</h2><p class="bp-section-desc">${sec.desc}</p></div>`;
          }
        }
      }

      return html;
    }

    // ─── API call ───
    async function callAPI(messages, maxTokens) {
      if (typeof CONFIG === "undefined" || !CONFIG.ANTHROPIC_API_KEY || CONFIG.ANTHROPIC_API_KEY.startsWith("your-")) {
        throw new Error("API key not configured. Add your Anthropic API key in the CONFIG section near the top of this file.");
      }

      const res = await fetch(API_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": CONFIG.ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
          "anthropic-dangerous-direct-browser-access": "true",
        },
        body: JSON.stringify({
          model: MODEL,
          max_tokens: maxTokens || MAX_TOKENS,
          system: SYSTEM_PROMPT,
          messages: messages.map(m => ({ role: m.role, content: m.content })),
        }),
      });

      if (!res.ok) {
        const body = await res.text();
        throw new Error(`API error ${res.status}: ${body}`);
      }

      const data = await res.json();
      return data.content[0].text;
    }

    // ─── chat send ───
    async function sendMessage() {
      if (chatBusy) return;
      const input = $("#userInput");
      const text = input.value.trim();
      if (!text) return;

      input.value = "";
      input.style.height = "auto";

      // Auto-create a campaign if none exists yet
      if (!currentCampaignId) {
        currentCampaignId = createCampaignRecord();
        renderCampaignList();
        updateBlueprintPanelTitle();
      }

      disableAllOptionButtons();
      addMessage("user", text);
      conversationHistory.push({ role: "user", content: text });

      chatBusy = true;
      $("#sendBtn").disabled = true;
      setTyping(true);

      try {
        const rawReply = await callAPI(conversationHistory, CHAT_MAX_TOKENS);
        const reply = extractDirectives(rawReply);
        conversationHistory.push({ role: "assistant", content: rawReply });
        addMessage("assistant", reply);
        saveCurrent();
        // Auto-stream blueprint in the background
        streamBlueprint();
      } catch (err) {
        addErrorMessage("Something went wrong: " + err.message);
      } finally {
        chatBusy = false;
        $("#sendBtn").disabled = false;
        setTyping(false);
      }
    }

    function handleInputKey(e) {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
      }
      // auto-grow textarea
      requestAnimationFrame(() => {
        e.target.style.height = "auto";
        e.target.style.height = Math.min(e.target.scrollHeight, 120) + "px";
      });
    }

    // ─── streaming blueprint update ───
    // rawBlueprintMarkdown declared earlier near progress tracking
    let blueprintAbortController = null;

    // Minimum conversation turns before auto-generating a blueprint
    const MIN_TURNS_FOR_BLUEPRINT = 2;

    function shouldAutoBlueprint() {
      // Count user messages (excluding the initial "Hello")
      const userMsgs = conversationHistory.filter(m => m.role === "user" && m.content !== "Hello");
      return userMsgs.length >= MIN_TURNS_FOR_BLUEPRINT;
    }

    async function streamBlueprint() {
      if (conversationHistory.length === 0) return;
      if (!shouldAutoBlueprint()) return;

      // If a blueprint is already streaming, queue a re-run instead of aborting.
      // This ensures at least one blueprint call always completes — fixing a race
      // condition where rapid user responses would repeatedly abort in-progress
      // streams, leaving the preview empty.
      if (blueprintBusy) {
        blueprintPendingRerun = true;
        return;
      }
      blueprintPendingRerun = false;
      blueprintAbortController = new AbortController();

      blueprintBusy = true;
      const bpEl = $("#bpContent");
      const bufferEl = $("#bpBuffer");
      const previousMarkdown = rawBlueprintMarkdown;

      // Keep existing skeleton/content visible — only show spinner dot
      $("#bpPlaceholder").style.display = "none";
      bpEl.classList.add("visible");
      $("#bpStreamingDot").classList.add("active");

      // Clear hidden buffer for incoming content
      bufferEl.innerHTML = "";

      const bpMessages = [
        ...conversationHistory.map(m => ({ role: m.role, content: m.content })),
        {
          role: "user",
          content: "Based on everything we've discussed so far, output ONLY the blueprint sections for which we have actually collected sufficient information through our conversation. Do NOT include sections we haven't discussed yet — no placeholders, no TBD sections, no skeleton outlines for future sections.\n\nThe full list of blueprint sections with their CANONICAL numbers is:\n1. Executive Summary\n2. Campaign Concept\n3. Target Audience & Sales Motion\n4. Business Goal & Impact Type\n5. KPIs & Measurement\n6. Core Insight\n7. Hypothesis\n8. Scope & Size\n9. Timeline\n10. Needs Assessment\n11. Blind Spots & Assumptions\n12. Strategic Quality Assessment\n\nFor each section where we have discussed and collected sufficient information in the conversation, include that section in the output. If a section has not been discussed yet, omit it entirely.\n\nSECTION DESCRIPTIONS:\n- Section 2 (Campaign Concept): The elevator pitch — what you're doing, the product/solution context, and why it matters to your audience. Combine campaign focus with product positioning.\n- Section 3 (Target Audience & Sales Motion): Who you're reaching and how you sell to them — persona, segment, and go-to-market motion.\n- Section 4 (Business Goal & Impact Type): The business outcome this campaign is designed to drive.\n- Section 5 (KPIs & Measurement): How success will be measured — key metrics and targets.\n- Section 6 (Core Insight): The audience truth that makes this campaign resonate.\n- Section 7 (Hypothesis): Structured as: If we [action] for [persona], then [outcome] because [insight].\n- Section 8 (Scope & Size): T-shirt size (S/M/L/XL) based on channels, content, teams, and duration.\n- Section 9 (Timeline): Expected duration, phases, and key milestones.\n- Section 10 (Needs Assessment): Content & creative assets, channel mix, sales enablement, teams & ops requirements, and localization.\n- Section 11 (Blind Spots & Assumptions): Risks, blind spots, and untested assumptions the user might have missed.\n- Section 12 (Strategic Quality Assessment): Alignment, impact potential, and readiness evaluation with scorecards.\n\nCRITICAL DATA-READINESS RULES — which sections to include:\n- Section 1 (Executive Summary) is a SYNTHESIS section. Include it once at least Core Insight AND Hypothesis have been discussed. It should synthesize the campaign's purpose, audience, business goal, insight, and hypothesis into a concise 5-7 bullet executive overview.\n- Section 3 (Target Audience & Sales Motion): Do NOT include until the user has EXPLICITLY stated who the target audience is AND the sales motion or business segment.\n- Section 4 (Business Goal & Impact Type) and Section 5 (KPIs & Measurement): Do NOT include until the user has explicitly discussed business goals and success metrics.\n- For all other sections: only include if the user has directly provided the relevant information in conversation.\n\nIMPORTANT: Output ONLY the formatted blueprint markdown. Do NOT include any conversational text, questions, commentary, or requests for more information. If you don't have enough info for a section, simply omit that section entirely. Never mix conversation with blueprint output.\n\nFormatting rules:\n- Use a markdown # heading for the campaign title at the top.\n- ALWAYS use the CANONICAL section number in headings, even if earlier sections are omitted. For example, if only Target Audience is ready, output ## 3. Target Audience & Sales Motion (NOT ## 1.).\n- Use standard markdown bullet lists with '- ' (dash space) for all bullet points. NEVER use the • bullet character.\n- Use **bold** for key labels within bullets (e.g., - **Campaign Focus**: ...).\n- Each bullet point MUST be on its own line.\n\nSPECIAL FORMATTING for Section 12 (Strategic Quality Assessment):\nFor the three assessment dimensions (Alignment with Business Goals, Potential Impact, Readiness / Feasibility), you MUST use scorecard directives instead of plain bullets. Output each as:\n<!--SCORECARD:Dimension Name|Tier Label|1-2 sentence rationale|color-->\nColor mapping: Strongly Aligned/High/Ready→green, Partially Aligned/Medium/Some Gaps→amber, Needs Work/Low/Not Ready→red\nOutput all three scorecard directives consecutively. You may include the Overall Verdict as regular markdown text after the scorecards.",
        },
      ];

      try {
        if (typeof CONFIG === "undefined" || !CONFIG.ANTHROPIC_API_KEY || CONFIG.ANTHROPIC_API_KEY.startsWith("your-")) {
          throw new Error("API key not configured.");
        }

        const res = await fetch(API_URL, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": CONFIG.ANTHROPIC_API_KEY,
            "anthropic-version": "2023-06-01",
            "anthropic-dangerous-direct-browser-access": "true",
          },
          body: JSON.stringify({
            model: MODEL,
            max_tokens: MAX_TOKENS,
            stream: true,
            system: SYSTEM_PROMPT,
            messages: bpMessages,
          }),
          signal: blueprintAbortController.signal,
        });

        if (!res.ok) {
          const body = await res.text();
          throw new Error(`API error ${res.status}: ${body}`);
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let incomingMarkdown = "";
        let blueprintConfirmed = false; // has the incoming content proven to be a real blueprint?

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop(); // keep incomplete line in buffer

          for (const line of lines) {
            if (line.startsWith("data: ")) {
              const jsonStr = line.slice(6).trim();
              if (jsonStr === "[DONE]") continue;
              try {
                const event = JSON.parse(jsonStr);
                if (event.type === "content_block_delta" && event.delta && event.delta.text) {
                  incomingMarkdown += event.delta.text;

                  // Check if this looks like actual blueprint content (has a markdown heading)
                  if (!blueprintConfirmed && /^#{1,3}\s/m.test(incomingMarkdown)) {
                    blueprintConfirmed = true;
                    bpEl.classList.add("fading");
                  }

                  // Stream into hidden buffer — existing content stays untouched
                  if (blueprintConfirmed) {
                    bufferEl.innerHTML = renderBlueprintWithPhases(incomingMarkdown);
                  }
                }
              } catch (e) {
                // skip unparseable lines
              }
            }
          }
        }

        // Stream finished — merge incoming sections with existing ones
        // so inline BP_START/BP_END updates aren't lost
        if (blueprintConfirmed) {
          // Strip any chat-style blue spans that leaked into blueprint output
          incomingMarkdown = stripChatSpans(incomingMarkdown);
          const existing = parseBlueprintSections(rawBlueprintMarkdown);
          const incoming = parseBlueprintSections(incomingMarkdown);
          // Use incoming title if available, otherwise keep existing
          const mergedTitle = incoming.title || existing.title;
          const mergedSections = { ...existing.sections };
          // Overwrite with incoming sections (they're fresher)
          for (const [num, content] of Object.entries(incoming.sections)) {
            mergedSections[num] = content;
          }
          rawBlueprintMarkdown = buildBlueprintMarkdown(mergedTitle, mergedSections);
          bpEl.classList.remove("fading");
          bpEl.innerHTML = renderBlueprintWithPhases(rawBlueprintMarkdown);
          bpEl.classList.add("visible");
          bufferEl.innerHTML = "";
          $("#copyBtn").classList.add("visible"); $("#exportDropdown").classList.add("visible");
        } else {
          // Incoming content was NOT a real blueprint — keep previous content
          rawBlueprintMarkdown = previousMarkdown;
          bpEl.classList.remove("fading");
          bpEl.innerHTML = renderBlueprintWithPhases(rawBlueprintMarkdown);
          if (previousMarkdown) {
            $("#copyBtn").classList.add("visible"); $("#exportDropdown").classList.add("visible");
          }
        }

        saveCurrent();
      } catch (err) {
        if (err.name === "AbortError") {
          bufferEl.innerHTML = "";
          return;
        }
        // On error, keep existing content
        bufferEl.innerHTML = "";
        rawBlueprintMarkdown = previousMarkdown;
        bpEl.classList.remove("fading");
        bpEl.innerHTML = renderBlueprintWithPhases(rawBlueprintMarkdown);
        if (previousMarkdown) {
          $("#copyBtn").classList.add("visible"); $("#exportDropdown").classList.add("visible");
        }
      } finally {
        blueprintBusy = false;
        blueprintAbortController = null;
        $("#bpStreamingDot").classList.remove("active");
        $("#bpContent").classList.remove("fading");

        // If new messages arrived while we were streaming, re-run with latest context
        if (blueprintPendingRerun) {
          blueprintPendingRerun = false;
          streamBlueprint();
        }
      }
    }

    // Keep legacy function name for any existing references
    async function updateBlueprint() {
      return streamBlueprint();
    }

    // ─── copy (rich text) ───
    async function copyBlueprint() {
      try {
        // Build styled HTML with phase headers for rich-text paste (Google Docs, Word, etc.)
        const parsed = parseBlueprintSections(rawBlueprintMarkdown);
        let body = "";

        // Campaign title
        if (parsed.title) {
          body += `<h1 style="font-family: 'Open Sans', Arial, sans-serif; font-size: 20pt; font-weight: 700; color: #4338CA; margin: 0 0 4px; padding-bottom: 8px; border-bottom: 3px solid #4338CA;">${parsed.title}</h1>`;
        }

        // Executive Summary at top (strip section numbers from headings)
        if (parsed.sections[1]) {
          let execHtml = renderMarkdown(parsed.sections[1]);
          execHtml = execHtml.replace(/<h2>\d+\.\s*/g, "<h2>");
          body += styledSection(execHtml);
        }

        // Phase-grouped sections
        for (const group of BLUEPRINT_LAYOUT) {
          // Phase header — styled as a colored label
          body += `<p style="font-family: 'Open Sans', Arial, sans-serif; font-size: 9pt; font-weight: 700; color: #4A4578; margin: 28px 0 6px; padding-top: 14px; border-top: 1px solid #D8D5F2; letter-spacing: 1px;">${group.phase.toUpperCase()}</p>`;

          for (const sec of group.sections) {
            if (parsed.sections[sec.num]) {
              let secHtml = renderMarkdown(parsed.sections[sec.num]);
              secHtml = secHtml.replace(/<h2>\d+\.\s*/g, "<h2>");
              body += styledSection(secHtml);
            }
          }
        }

        const richHtml = `<html><body style="font-family: 'Open Sans', Arial, Helvetica, sans-serif; color: #1A1A2E; font-size: 10.5pt; line-height: 1.6;">${body}</body></html>`;

        const htmlBlob = new Blob([richHtml], { type: "text/html" });
        const textBlob = new Blob([rawBlueprintMarkdown], { type: "text/plain" });
        await navigator.clipboard.write([
          new ClipboardItem({
            "text/html": htmlBlob,
            "text/plain": textBlob,
          }),
        ]);
        const btn = $("#copyBtn");
        btn.classList.add("copied");
        setTimeout(() => { btn.classList.remove("copied"); }, 2000);
      } catch {
        alert("Copy failed — please select and copy manually.");
      }
    }

    // Apply inline styles to rendered HTML for clipboard paste (Google Docs, Word)
    function styledSection(html) {
      return html
        .replace(/<h2>/g, '<h2 style="font-family: \'Open Sans\', Arial, sans-serif; font-size: 13pt; font-weight: 700; color: #3D38B0; margin: 20px 0 6px;">')
        .replace(/<h3>/g, '<h3 style="font-family: \'Open Sans\', Arial, sans-serif; font-size: 11pt; font-weight: 600; color: #5B21B6; margin: 14px 0 4px;">')
        .replace(/<p>/g, '<p style="font-family: \'Open Sans\', Arial, sans-serif; margin: 0 0 8px; color: #1A1A2E;">')
        .replace(/<ul>/g, '<ul style="margin: 4px 0 12px 18px; padding: 0; color: #1A1A2E;">')
        .replace(/<ol>/g, '<ol style="margin: 4px 0 12px 18px; padding: 0; color: #1A1A2E;">')
        .replace(/<li>/g, '<li style="font-family: \'Open Sans\', Arial, sans-serif; margin-bottom: 4px; color: #1A1A2E;">')
        .replace(/<table>/g, '<table style="width: 100%; border-collapse: collapse; margin: 12px 0; font-size: 10pt;">')
        .replace(/<th>/g, '<th style="font-family: \'Open Sans\', Arial, sans-serif; padding: 8px 12px; border: 1px solid #D8D5F2; background: #EEF2FF; font-weight: 600; text-align: left; color: #1A1A2E;">')
        .replace(/<td>/g, '<td style="font-family: \'Open Sans\', Arial, sans-serif; padding: 8px 12px; border: 1px solid #D8D5F2; text-align: left; color: #1A1A2E;">')
        .replace(/<strong>/g, '<strong style="font-weight: 600; color: #1A1A2E;">');
    }

    // ─── Google Docs export ───
    const GOOGLE_CLIENT_ID = "1078618287159-phnl3sp89063aja49tsgjqi3br5ov4ob.apps.googleusercontent.com";
    let googleAccessToken = null;

    function getGoogleAccessToken() {
      return new Promise((resolve, reject) => {
        if (typeof google === "undefined" || !google.accounts) {
          reject(new Error("Google Identity Services not loaded. Please check your internet connection and refresh."));
          return;
        }
        const client = google.accounts.oauth2.initTokenClient({
          client_id: GOOGLE_CLIENT_ID,
          scope: "https://www.googleapis.com/auth/documents https://www.googleapis.com/auth/drive.file",
          callback: (response) => {
            if (response.error) { reject(new Error(response.error)); return; }
            googleAccessToken = response.access_token;
            resolve(response.access_token);
          },
        });
        client.requestAccessToken();
      });
    }

    function markdownToDocsRequests(md) {
      const requests = [];
      let idx = 1; // Docs API uses 1-based index
      const lines = md.split("\n");

      for (const line of lines) {
        let text = "";
        let style = null;

        if (line.startsWith("### ")) {
          text = line.slice(4) + "\n";
          style = "HEADING_3";
        } else if (line.startsWith("## ")) {
          text = line.slice(3) + "\n";
          style = "HEADING_2";
        } else if (line.startsWith("# ")) {
          text = line.slice(2) + "\n";
          style = "HEADING_1";
        } else if (line.startsWith("- ") || line.startsWith("* ")) {
          text = line.slice(2) + "\n";
        } else if (/^\d+\.\s/.test(line)) {
          text = line + "\n";
        } else if (line.trim() === "---") {
          text = "\n";
        } else {
          text = (line || "") + "\n";
        }

        if (!text) continue;

        // Insert text
        requests.push({
          insertText: { location: { index: idx }, text }
        });

        // Apply heading style
        if (style) {
          requests.push({
            updateParagraphStyle: {
              range: { startIndex: idx, endIndex: idx + text.length },
              paragraphStyle: { namedStyleType: style },
              fields: "namedStyleType"
            }
          });
        }

        // Apply bullet style for list items
        if (line.startsWith("- ") || line.startsWith("* ")) {
          requests.push({
            createParagraphBullets: {
              range: { startIndex: idx, endIndex: idx + text.length },
              bulletPreset: "BULLET_DISC_CIRCLE_SQUARE"
            }
          });
        }

        // Bold text between **...**
        const boldRegex = /\*\*(.+?)\*\*/g;
        let match;
        // We need to find bold markers in the inserted text (without the ** markers)
        // Since we're inserting raw markdown, we should strip ** and apply bold
        // Actually, let's strip ** from the text before inserting and track positions

        idx += text.length;
      }

      return requests;
    }

    function markdownToCleanDocsRequests(md) {
      // Rich formatting: Open Sans font, styled headings with colors & spacing
      const requests = [];
      let idx = 1;
      const lines = md.split("\n");

      // Track heading ranges for post-insert styling
      const headingRanges = [];

      // Brand colors
      const colors = {
        h1: { red: 67/255, green: 56/255, blue: 202/255 },   // #4338CA
        h2: { red: 61/255, green: 56/255, blue: 176/255 },    // #3D38B0
        h3: { red: 91/255, green: 33/255, blue: 182/255 },    // #5B21B6
        body: { red: 26/255, green: 26/255, blue: 46/255 },   // #1A1A2E
      };

      for (const line of lines) {
        if (line.trim() === "---") {
          // Insert horizontal rule as a styled empty paragraph
          requests.push({ insertText: { location: { index: idx }, text: "\n" } });
          requests.push({
            updateParagraphStyle: {
              range: { startIndex: idx, endIndex: idx + 1 },
              paragraphStyle: {
                borderBottom: {
                  color: { color: { rgbColor: { red: 224/255, green: 222/255, blue: 247/255 } } },
                  width: { magnitude: 1, unit: "PT" },
                  padding: { magnitude: 6, unit: "PT" },
                  dashStyle: "SOLID"
                },
                spaceBelow: { magnitude: 8, unit: "PT" }
              },
              fields: "borderBottom,spaceBelow"
            }
          });
          idx += 1;
          continue;
        }

        let heading = null;
        let rawText = line;
        let isBullet = false;

        if (line.startsWith("### ")) { rawText = line.slice(4); heading = "HEADING_3"; }
        else if (line.startsWith("## ")) { rawText = line.slice(3); heading = "HEADING_2"; }
        else if (line.startsWith("# ")) { rawText = line.slice(2); heading = "HEADING_1"; }
        else if (line.startsWith("- ") || line.startsWith("* ")) { rawText = line.slice(2); isBullet = true; }

        // Strip bold markers and track positions
        const boldRanges = [];
        let cleanText = "";
        let i = 0;
        while (i < rawText.length) {
          if (rawText.slice(i, i + 2) === "**") {
            const end = rawText.indexOf("**", i + 2);
            if (end !== -1) {
              const boldStart = cleanText.length;
              const boldContent = rawText.slice(i + 2, end);
              cleanText += boldContent;
              boldRanges.push({ start: boldStart, end: cleanText.length });
              i = end + 2;
              continue;
            }
          }
          cleanText += rawText[i];
          i++;
        }

        const text = cleanText + "\n";
        requests.push({ insertText: { location: { index: idx }, text } });

        if (heading) {
          requests.push({
            updateParagraphStyle: {
              range: { startIndex: idx, endIndex: idx + text.length },
              paragraphStyle: { namedStyleType: heading },
              fields: "namedStyleType"
            }
          });
          headingRanges.push({ start: idx, end: idx + text.length, level: heading });
        }

        if (isBullet) {
          requests.push({
            createParagraphBullets: {
              range: { startIndex: idx, endIndex: idx + text.length },
              bulletPreset: "BULLET_DISC_CIRCLE_SQUARE"
            }
          });
        }

        for (const b of boldRanges) {
          requests.push({
            updateTextStyle: {
              range: { startIndex: idx + b.start, endIndex: idx + b.end },
              textStyle: { bold: true },
              fields: "bold"
            }
          });
        }

        idx += text.length;
      }

      const endIdx = idx;

      // Apply Open Sans font to entire document body
      requests.push({
        updateTextStyle: {
          range: { startIndex: 1, endIndex: endIdx },
          textStyle: {
            weightedFontFamily: { fontFamily: "Open Sans", weight: 400 },
            foregroundColor: { color: { rgbColor: colors.body } },
            fontSize: { magnitude: 10, unit: "PT" }
          },
          fields: "weightedFontFamily,foregroundColor,fontSize"
        }
      });

      // Style headings with colors, sizes, and spacing
      for (const h of headingRanges) {
        let fontSize, color, spaceAbove, spaceBelow;
        if (h.level === "HEADING_1") {
          fontSize = 20; color = colors.h1; spaceAbove = 24; spaceBelow = 8;
        } else if (h.level === "HEADING_2") {
          fontSize = 14; color = colors.h2; spaceAbove = 18; spaceBelow = 6;
        } else {
          fontSize = 12; color = colors.h3; spaceAbove = 14; spaceBelow = 4;
        }

        requests.push({
          updateTextStyle: {
            range: { startIndex: h.start, endIndex: h.end },
            textStyle: {
              weightedFontFamily: { fontFamily: "Open Sans", weight: 700 },
              foregroundColor: { color: { rgbColor: color } },
              fontSize: { magnitude: fontSize, unit: "PT" }
            },
            fields: "weightedFontFamily,foregroundColor,fontSize"
          }
        });

        requests.push({
          updateParagraphStyle: {
            range: { startIndex: h.start, endIndex: h.end },
            paragraphStyle: {
              spaceAbove: { magnitude: spaceAbove, unit: "PT" },
              spaceBelow: { magnitude: spaceBelow, unit: "PT" }
            },
            fields: "spaceAbove,spaceBelow"
          }
        });
      }

      // Add body text line spacing
      requests.push({
        updateParagraphStyle: {
          range: { startIndex: 1, endIndex: endIdx },
          paragraphStyle: {
            lineSpacing: 135
          },
          fields: "lineSpacing"
        }
      });

      return requests;
    }

    function toggleExportMenu() {
      const menu = $("#exportMenu");
      const isOpen = menu.classList.contains("open");
      menu.classList.toggle("open", !isOpen);
      if (!isOpen) {
        // Close menu when clicking outside
        setTimeout(() => {
          document.addEventListener("click", function closeMenu(e) {
            if (!$("#exportDropdown").contains(e.target)) {
              menu.classList.remove("open");
              document.removeEventListener("click", closeMenu);
            }
          });
        }, 0);
      }
    }

    function exportToPDF() {
      $("#exportMenu").classList.remove("open");
      if (!rawBlueprintMarkdown) { alert("No blueprint to export yet."); return; }

      let docTitle = "Campaign Blueprint";
      if (currentCampaignId) {
        const campaigns = loadAllCampaigns();
        const c = campaigns.find(c => c.id === currentCampaignId);
        if (c && c.title && c.title !== "Untitled Campaign") docTitle = c.title + " — Blueprint";
      }

      const content = $("#bpContent").innerHTML;
      const styledHtml = `<!DOCTYPE html><html><head><title>${docTitle}</title>
        <link href="https://fonts.googleapis.com/css2?family=Open+Sans:wght@400;600;700&display=swap" rel="stylesheet">
        <style>
          body { font-family: 'Open Sans', sans-serif; max-width: 800px; margin: 40px auto; padding: 0 20px; color: #1a1a2e; line-height: 1.6; font-size: 10pt; }
          h1 { font-family: 'Open Sans', sans-serif; font-size: 20pt; font-weight: 700; color: #4338CA; border-bottom: 2px solid #E0DEF7; padding-bottom: 8px; margin-top: 24px; margin-bottom: 8px; }
          h2 { font-family: 'Open Sans', sans-serif; font-size: 14pt; font-weight: 700; color: #3D38B0; margin-top: 18px; margin-bottom: 6px; text-transform: uppercase; letter-spacing: 0.04em; }
          h3 { font-family: 'Open Sans', sans-serif; font-size: 12pt; font-weight: 600; color: #5B21B6; margin-top: 14px; margin-bottom: 4px; }
          p { margin: 0 0 10px; }
          ul, ol { padding-left: 1.5em; margin: 4px 0 14px; }
          li { margin-bottom: 4px; }
          strong { font-weight: 600; color: #1e1b4b; }
          hr { border: none; border-top: 1px solid #E0DEF7; margin: 1.5em 0; }
          table { width: 100%; border-collapse: collapse; margin: 14px 0; font-size: 10pt; }
          th { padding: 8px 12px; border: 1px solid #D8D5F2; background: #EEF2FF; font-weight: 600; text-align: left; }
          td { padding: 8px 12px; border: 1px solid #D8D5F2; text-align: left; }
          .bp-phase-header { display: none; }
          .sq-scorecard { margin: 16px 0; }
          .sq-card { padding: 12px 16px; border-radius: 8px; border: 1px solid; margin-bottom: 8px; }
          .sq-card.sq-green { background: rgba(93, 188, 180, 0.08); border-color: rgba(93, 188, 180, 0.25); }
          .sq-card.sq-amber { background: rgba(249, 115, 22, 0.06); border-color: rgba(249, 115, 22, 0.18); }
          .sq-card.sq-red { background: rgba(227, 62, 62, 0.06); border-color: rgba(227, 62, 62, 0.18); }
          .sq-tier { font-size: 9pt; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em; margin-bottom: 2px; }
          .sq-green .sq-tier { color: #5dbcb4; }
          .sq-amber .sq-tier { color: #F97316; }
          .sq-red .sq-tier { color: #E53E3E; }
          .sq-dimension { font-size: 11pt; font-weight: 700; color: #1A1A1A; margin-bottom: 4px; }
          .sq-rationale { font-size: 10pt; line-height: 1.55; color: #555; }
          .sq-dot { display: none; }
          @media print { body { margin: 0; } }
        </style></head><body>${content}</body></html>`;

      // Use an iframe to trigger direct PDF download via print-to-PDF
      const iframe = document.createElement("iframe");
      iframe.style.position = "fixed";
      iframe.style.right = "0";
      iframe.style.bottom = "0";
      iframe.style.width = "0";
      iframe.style.height = "0";
      iframe.style.border = "0";
      document.body.appendChild(iframe);
      iframe.contentDocument.open();
      iframe.contentDocument.write(styledHtml);
      iframe.contentDocument.close();

      iframe.contentWindow.onafterprint = () => {
        document.body.removeChild(iframe);
      };

      // Wait for fonts to load then print
      setTimeout(() => {
        iframe.contentWindow.focus();
        iframe.contentWindow.print();
        // Fallback cleanup if onafterprint doesn't fire
        setTimeout(() => { if (iframe.parentNode) document.body.removeChild(iframe); }, 60000);
      }, 500);
    }

    async function exportToGoogleDocs() {
      $("#exportMenu").classList.remove("open");
      if (!rawBlueprintMarkdown) { alert("No blueprint to export yet."); return; }

      const btn = $("#exportBtn");
      btn.disabled = true;

      try {
        const token = await getGoogleAccessToken();

        let docTitle = "Campaign Blueprint";
        if (currentCampaignId) {
          const campaigns = loadAllCampaigns();
          const c = campaigns.find(c => c.id === currentCampaignId);
          if (c && c.title && c.title !== "Untitled Campaign") docTitle = c.title + " — Blueprint";
        }

        // Create blank doc
        const createRes = await fetch("https://docs.googleapis.com/v1/documents", {
          method: "POST",
          headers: {
            "Authorization": "Bearer " + token,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ title: docTitle }),
        });
        if (!createRes.ok) throw new Error("Failed to create document: " + (await createRes.text()));
        const doc = await createRes.json();
        const docId = doc.documentId;

        // Build requests from markdown
        const requests = markdownToCleanDocsRequests(rawBlueprintMarkdown);

        if (requests.length > 0) {
          const updateRes = await fetch(`https://docs.googleapis.com/v1/documents/${docId}:batchUpdate`, {
            method: "POST",
            headers: {
              "Authorization": "Bearer " + token,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ requests }),
          });
          if (!updateRes.ok) throw new Error("Failed to populate document: " + (await updateRes.text()));
        }

        window.open(`https://docs.google.com/document/d/${docId}/edit`, "_blank");
        btn.disabled = false;

      } catch (err) {
        console.error("Google Docs export error:", err);
        btn.disabled = false;
        if (err.message.includes("not loaded")) {
          alert(err.message);
        } else if (err.message.includes("popup_closed") || err.message.includes("access_denied")) {
          // User cancelled
        } else {
          alert("Export failed: " + err.message);
        }
      }
    }

    // ─── cold start greeting ───
    async function coldStart() {
      chatBusy = true;
      $("#sendBtn").disabled = true;
      setTyping(true);

      try {
        const initMessages = [
          { role: "user", content: "Hello" },
        ];
        const rawReply = await callAPI(initMessages);
        const reply = extractDirectives(rawReply);
        conversationHistory.push({ role: "user", content: "Hello" });
        conversationHistory.push({ role: "assistant", content: rawReply });
        addMessage("assistant", reply);
        saveCurrent();
      } catch (err) {
        addErrorMessage("Could not connect to the AI. " + err.message);
      } finally {
        chatBusy = false;
        $("#sendBtn").disabled = false;
        setTyping(false);
      }
    }

    // ─── drag-to-resize panels ───
    (function () {
      const handle = document.getElementById("dragHandle");
      const panels = document.querySelector(".panels");
      let dragging = false;

      handle.addEventListener("mousedown", (e) => {
        e.preventDefault();
        dragging = true;
        handle.classList.add("dragging");
        document.body.style.cursor = "col-resize";
        document.body.style.userSelect = "none";
      });

      window.addEventListener("mousemove", (e) => {
        if (!dragging) return;
        const rect = panels.getBoundingClientRect();
        const offset = e.clientX - rect.left;
        const total = rect.width - handle.offsetWidth - 12; // account for handle + margins
        const leftPct = Math.max(20, Math.min(80, (offset / rect.width) * 100));
        const rightPct = 100 - leftPct;
        const chatPanel = panels.querySelector(".chat-panel");
        const bpPanel = panels.querySelector(".blueprint-panel");
        chatPanel.style.flex = leftPct;
        bpPanel.style.flex = rightPct;
      });

      window.addEventListener("mouseup", () => {
        if (!dragging) return;
        dragging = false;
        handle.classList.remove("dragging");
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
      });
    })();

    // ─── init ───
    window.addEventListener("DOMContentLoaded", () => {
      // Initialize bot avatar (geodesic dome)
      const botAv = document.getElementById("botAvatar");
      if (botAv) botAv.innerHTML = getBotAvatarImg();

      // Initialize avatar and display name
      refreshAllUserAvatars();
      refreshDisplayName();

      // Drag-and-drop for avatar upload
      const dropArea = document.getElementById("avatarUploadArea");
      ["dragenter", "dragover"].forEach(evt => {
        dropArea.addEventListener(evt, e => { e.preventDefault(); dropArea.style.borderColor = "#3D38B0"; dropArea.style.background = "#F5F3FF"; });
      });
      ["dragleave", "drop"].forEach(evt => {
        dropArea.addEventListener(evt, e => { e.preventDefault(); dropArea.style.borderColor = ""; dropArea.style.background = ""; });
      });
      dropArea.addEventListener("drop", e => {
        const file = e.dataTransfer.files[0];
        if (!file || !file.type.startsWith("image/")) return;
        if (file.size > 2 * 1024 * 1024) { alert("Image must be under 2 MB."); return; }
        const reader = new FileReader();
        reader.onload = ev => {
          saveAvatar({ type: "upload", value: ev.target.result });
          refreshAllUserAvatars();
          if (document.getElementById("avatarModalBackdrop").classList.contains("visible")) openAvatarPicker();
        };
        reader.readAsDataURL(file);
      });

      const campaigns = loadAllCampaigns();
      if (campaigns.length > 0) {
        // Resume most recent campaign
        const most = campaigns.sort((a, b) => b.updatedAt - a.updatedAt)[0];
        currentCampaignId = most.id;
        conversationHistory = most.conversationHistory || [];
        rawBlueprintMarkdown = most.blueprintMarkdown || "";

        // Rebuild chat UI
        conversationHistory.forEach(m => {
          if (m.role === "user" && m.content === "Hello") return;
          const display = m.role === "assistant" ? stripDirectives(m.content) : m.content;
          addMessage(m.role, display);
        });

        // Rebuild blueprint — always show skeleton
        $("#bpPlaceholder").style.display = "none";
        renderCampaignList();
        restoreProgressFromHistory();
        $("#bpContent").innerHTML = renderBlueprintWithPhases(rawBlueprintMarkdown);
        $("#bpContent").classList.add("visible");
        if (rawBlueprintMarkdown) {
          $("#copyBtn").classList.add("visible"); $("#exportDropdown").classList.add("visible");
        }
      } else {
        // First visit or empty — show skeleton
        currentCampaignId = null;
        conversationHistory = [];
        rawBlueprintMarkdown = "";
        $("#bpPlaceholder").style.display = "none";
        $("#bpContent").innerHTML = renderBlueprintWithPhases("");
        $("#bpContent").classList.add("visible");
        renderCampaignList();
      }
    });
