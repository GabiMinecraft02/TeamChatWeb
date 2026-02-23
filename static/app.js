/* ═══════════════════════════════════════════
   TEAMCHAT — Client JS
   Socket.IO (texte) + WebRTC (voix)
   ═══════════════════════════════════════════ */

const socket = io({ transports: ["websocket"] });

// ─── Utilitaires ─────────────────────────────────────────────

function scrollBottom() {
  const box = document.getElementById("messages");
  box.scrollTop = box.scrollHeight;
}

function escapeHtml(s) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ─── Chat texte ───────────────────────────────────────────────

function appendMessage(pseudo, content, time, isMine) {
  const msgs = document.getElementById("messages");
  const div = document.createElement("div");
  div.className = `msg ${isMine ? "mine" : "other"}`;
  div.innerHTML = `
    <div class="msg-meta">
      <span class="msg-pseudo">${isMine ? "Vous" : escapeHtml(pseudo)}</span>
      <span>${time}</span>
    </div>
    <div class="msg-bubble">${escapeHtml(content)}</div>
  `;
  msgs.appendChild(div);
  scrollBottom();
}

function appendSystem(text) {
  const msgs = document.getElementById("messages");
  const div = document.createElement("div");
  div.className = "system-msg";
  div.textContent = text;
  msgs.appendChild(div);
  scrollBottom();
}

function sendMessage() {
  const input = document.getElementById("msg-input");
  const content = input.value.trim();
  if (!content) return;
  socket.emit("send_message", { content });
  input.value = "";
  input.style.height = "auto";
}

document.getElementById("msg-input").addEventListener("input", function () {
  this.style.height = "auto";
  this.style.height = Math.min(this.scrollHeight, 120) + "px";
});

document.getElementById("msg-input").addEventListener("keydown", function (e) {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});

// ─── Socket.IO events ────────────────────────────────────────

socket.on("new_message", ({ pseudo, content, time }) => {
  appendMessage(pseudo, content, time, pseudo === MY_PSEUDO);
});

socket.on("system_message", ({ text }) => appendSystem(text));

socket.on("user_list", (users) => {
  // Sidebar desktop
  const ul = document.getElementById("user-list");
  if (ul) {
    ul.innerHTML = "";
    users.forEach((u) => {
      const li = document.createElement("li");
      li.className = "user-item";
      const isMe = u === MY_PSEUDO;
      li.innerHTML = `
        <span class="user-dot"></span>
        <span class="user-name ${isMe ? "is-me" : ""}">
          ${escapeHtml(u)}${isMe ? " (vous)" : ""}
        </span>
      `;
      ul.appendChild(li);
    });
  }

  // Barre mobile
  const mobileUsers = document.getElementById("mobile-users");
  if (mobileUsers) {
    mobileUsers.innerHTML = users.map(u => `
      <div class="mobile-user-pill ${u === MY_PSEUDO ? "me" : ""}">
        <span class="user-dot"></span>
        <span>${escapeHtml(u)}</span>
      </div>
    `).join("");
  }

  // Compteur dans le bouton mobile
  const counter = document.getElementById("online-count");
  if (counter) counter.textContent = users.length;
});

scrollBottom();

// ─── Mobile : drawer utilisateurs ────────────────────────────

function toggleDrawer() {
  const drawer = document.getElementById("mobile-drawer");
  drawer.classList.toggle("open");
}

// Fermer le drawer en cliquant en dehors
document.addEventListener("click", (e) => {
  const drawer = document.getElementById("mobile-drawer");
  const btn = document.getElementById("drawer-btn");
  if (drawer && !drawer.contains(e.target) && btn && !btn.contains(e.target)) {
    drawer.classList.remove("open");
  }
});

// ─── WebRTC ──────────────────────────────────────────────────

let localStream = null;
let peerConnections = {};
let inCall = false;
let isMuted = false;
let audioContext = null;       // AudioContext keepalive
let keepAliveNode = null;      // Nœud silencieux pour empêcher la suspension
let reconnectTimers = {};      // Timers de reconnexion par pair

const ICE_SERVERS = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
  ],
};

// ── Keepalive AudioContext (évite la suspension en arrière-plan) ──

function startAudioKeepAlive() {
  try {
    audioContext = new (window.AudioContext || window.webkitAudioContext)();
    // Oscillateur silencieux à volume 0 pour maintenir le contexte actif
    const osc = audioContext.createOscillator();
    const gain = audioContext.createGain();
    gain.gain.value = 0;
    osc.connect(gain);
    gain.connect(audioContext.destination);
    osc.start();
    keepAliveNode = { osc, gain };
  } catch (e) {
    console.warn("AudioContext keepalive non disponible:", e);
  }
}

function stopAudioKeepAlive() {
  try {
    if (keepAliveNode) {
      keepAliveNode.osc.stop();
      keepAliveNode = null;
    }
    if (audioContext) {
      audioContext.close();
      audioContext = null;
    }
  } catch (e) { /* ignore */ }
}

// Reprendre le contexte audio si suspendu (ex: retour d'arrière-plan)
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && audioContext?.state === "suspended") {
    audioContext.resume();
  }
  // Tenter de reconnecter les pairs perdus au retour
  if (document.visibilityState === "visible" && inCall) {
    checkAndReconnectPeers();
  }
});

// WakeLock : empêche l'écran de s'éteindre sur mobile
let wakeLock = null;

async function requestWakeLock() {
  try {
    if ("wakeLock" in navigator) {
      wakeLock = await navigator.wakeLock.request("screen");
    }
  } catch (e) { /* pas supporté partout */ }
}

function releaseWakeLock() {
  if (wakeLock) { wakeLock.release(); wakeLock = null; }
}

// Réacquérir le wake lock si la page redevient visible
document.addEventListener("visibilitychange", async () => {
  if (wakeLock !== null && document.visibilityState === "visible" && inCall) {
    await requestWakeLock();
  }
});

// ── Sélecteur de micro ───────────────────────────────────────

async function populateMicList() {
  const selects = document.querySelectorAll(".mic-select");
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const mics = devices.filter((d) => d.kind === "audioinput");
    selects.forEach(select => {
      const current = select.value;
      select.innerHTML = "";
      mics.forEach((mic, i) => {
        const opt = document.createElement("option");
        opt.value = mic.deviceId;
        opt.textContent = mic.label || `Micro ${i + 1}`;
        if (mic.deviceId === current) opt.selected = true;
        select.appendChild(opt);
      });
    });
  } catch (err) {
    console.warn("Impossible de lister les micros :", err);
  }
}

navigator.mediaDevices.addEventListener("devicechange", populateMicList);

document.querySelectorAll(".mic-select").forEach(sel => {
  sel.addEventListener("change", async () => {
    // Synchroniser les deux selects (desktop + mobile)
    const val = sel.value;
    document.querySelectorAll(".mic-select").forEach(s => s.value = val);
    if (inCall) await restartLocalStream();
  });
});

async function getLocalStream() {
  const sel = document.querySelector(".mic-select");
  const deviceId = sel?.value;
  const constraints = {
    audio: deviceId
      ? { deviceId: { exact: deviceId }, echoCancellation: true, noiseSuppression: true }
      : { echoCancellation: true, noiseSuppression: true },
    video: false,
  };
  return navigator.mediaDevices.getUserMedia(constraints);
}

async function restartLocalStream() {
  if (localStream) localStream.getTracks().forEach((t) => t.stop());
  localStream = await getLocalStream();
  localStream.getAudioTracks().forEach((t) => (t.enabled = !isMuted));
  const audioTrack = localStream.getAudioTracks()[0];
  Object.values(peerConnections).forEach((pc) => {
    const sender = pc.getSenders().find((s) => s.track?.kind === "audio");
    if (sender && audioTrack) sender.replaceTrack(audioTrack);
  });
}

// ── Mute ─────────────────────────────────────────────────────

function toggleMute() {
  if (!inCall) return;
  isMuted = !isMuted;
  if (localStream) {
    localStream.getAudioTracks().forEach((t) => (t.enabled = !isMuted));
  }
  document.querySelectorAll(".mute-btn").forEach(btn => {
    btn.classList.toggle("muted", isMuted);
    btn.querySelector(".mute-label").textContent = isMuted ? "Muet" : "Micro actif";
    btn.querySelector(".mute-icon").textContent = isMuted ? "🔇" : "🎤";
  });
}

// ── Rejoindre / Quitter ──────────────────────────────────────

function toggleVoice() {
  if (!inCall) joinVoice();
  else leaveVoice();
}

async function joinVoice() {
  try {
    // Demander la permission micro (nécessaire pour avoir les labels)
    await navigator.mediaDevices.getUserMedia({ audio: true });
    await populateMicList();
    localStream = await getLocalStream();
    inCall = true;
    isMuted = false;

    startAudioKeepAlive();
    await requestWakeLock();

    setVoiceUI(true);
    socket.emit("get_peers");
  } catch (err) {
    alert("Impossible d'accéder au micro : " + err.message);
  }
}

function leaveVoice() {
  inCall = false;
  isMuted = false;

  Object.keys(reconnectTimers).forEach(sid => {
    clearTimeout(reconnectTimers[sid]);
    delete reconnectTimers[sid];
  });

  if (localStream) {
    localStream.getTracks().forEach((t) => t.stop());
    localStream = null;
  }
  Object.values(peerConnections).forEach((pc) => pc.close());
  peerConnections = {};

  document.getElementById("audio-container").innerHTML = "";
  document.querySelectorAll(".peer-audio-list").forEach(el => el.innerHTML = "");

  stopAudioKeepAlive();
  releaseWakeLock();
  setVoiceUI(false);
}

function setVoiceUI(active) {
  document.querySelectorAll(".voice-btn").forEach(btn => {
    btn.classList.toggle("active", active);
    btn.querySelector(".voice-label").textContent = active ? "Raccrocher" : "Rejoindre l'appel";
    btn.querySelector(".voice-icon").textContent = active ? "📵" : "📞";
  });
  document.querySelectorAll(".mute-btn").forEach(btn => {
    btn.style.display = active ? "flex" : "none";
    btn.classList.remove("muted");
    btn.querySelector(".mute-label").textContent = "Micro actif";
    btn.querySelector(".mute-icon").textContent = "🎤";
  });
}

// ── Connexions WebRTC ────────────────────────────────────────

async function createPeerConnection(sid, pseudo, isInitiator) {
  // Fermer une connexion existante si elle existe
  if (peerConnections[sid]) {
    peerConnections[sid].close();
    delete peerConnections[sid];
  }

  const pc = new RTCPeerConnection(ICE_SERVERS);
  peerConnections[sid] = pc;

  if (localStream) {
    localStream.getTracks().forEach((track) => pc.addTrack(track, localStream));
  }

  pc.ontrack = (event) => addRemoteAudio(sid, pseudo, event.streams[0]);

  pc.onicecandidate = (event) => {
    if (event.candidate)
      socket.emit("webrtc_ice", { target: sid, candidate: event.candidate });
  };

  pc.onconnectionstatechange = () => {
    const state = pc.connectionState;
    if (state === "failed") {
      // Tentative de reconnexion après 2s
      removeRemoteAudio(sid);
      scheduleReconnect(sid, pseudo, isInitiator);
    } else if (state === "disconnected") {
      // Attendre un peu avant de déclarer mort
      reconnectTimers[sid] = setTimeout(() => {
        if (peerConnections[sid]?.connectionState === "disconnected") {
          removeRemoteAudio(sid);
          scheduleReconnect(sid, pseudo, isInitiator);
        }
      }, 3000);
    } else if (state === "connected") {
      if (reconnectTimers[sid]) {
        clearTimeout(reconnectTimers[sid]);
        delete reconnectTimers[sid];
      }
    } else if (state === "closed") {
      removeRemoteAudio(sid);
      delete peerConnections[sid];
    }
  };

  if (isInitiator) {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    socket.emit("webrtc_offer", { target: sid, offer });
  }

  return pc;
}

function scheduleReconnect(sid, pseudo, wasInitiator) {
  if (!inCall) return;
  reconnectTimers[sid] = setTimeout(async () => {
    if (!inCall) return;
    console.log(`Reconnexion vers ${pseudo}...`);
    await createPeerConnection(sid, pseudo, true);
  }, 2000);
}

function checkAndReconnectPeers() {
  Object.entries(peerConnections).forEach(([sid, pc]) => {
    if (["failed", "disconnected", "closed"].includes(pc.connectionState)) {
      scheduleReconnect(sid, "?", true);
    }
  });
}

function addRemoteAudio(sid, pseudo, stream) {
  let audio = document.getElementById(`audio-${sid}`);
  if (!audio) {
    audio = document.createElement("audio");
    audio.id = `audio-${sid}`;
    audio.autoplay = true;
    audio.setAttribute("playsinline", ""); // iOS
    document.getElementById("audio-container").appendChild(audio);
  }
  audio.srcObject = stream;

  document.querySelectorAll(".peer-audio-list").forEach(list => {
    if (!list.querySelector(`#peer-${sid}-${list.id}`)) {
      const item = document.createElement("div");
      item.id = `peer-${sid}-${list.id}`;
      item.className = "peer-audio-item";
      item.innerHTML = `
        <div class="audio-wave">
          <span></span><span></span><span></span><span></span><span></span>
        </div>
        <span>${escapeHtml(pseudo)}</span>
      `;
      list.appendChild(item);
    }
  });
}

function removeRemoteAudio(sid) {
  document.getElementById(`audio-${sid}`)?.remove();
  document.querySelectorAll(`[id^="peer-${sid}-"]`).forEach(el => el.remove());
}

// ── Signaling ────────────────────────────────────────────────

socket.on("peer_list", async (peers) => {
  for (const peer of peers) {
    if (!peerConnections[peer.sid])
      await createPeerConnection(peer.sid, peer.pseudo, true);
  }
});

socket.on("webrtc_offer", async ({ offer, from, pseudo }) => {
  if (!inCall) return;
  const pc = await createPeerConnection(from, pseudo, false);
  await pc.setRemoteDescription(new RTCSessionDescription(offer));
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  socket.emit("webrtc_answer", { target: from, answer });
});

socket.on("webrtc_answer", async ({ answer, from }) => {
  const pc = peerConnections[from];
  if (pc) await pc.setRemoteDescription(new RTCSessionDescription(answer));
});

socket.on("webrtc_ice", async ({ candidate, from }) => {
  const pc = peerConnections[from];
  if (pc && candidate) {
    try { await pc.addIceCandidate(new RTCIceCandidate(candidate)); }
    catch (_) { }
  }
});

window.addEventListener("beforeunload", leaveVoice);
