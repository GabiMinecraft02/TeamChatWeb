/* ═══════════════════════════════════════════
   TEAMCHAT — Client JS
   Socket.IO (texte) + WebRTC (voix)
   ═══════════════════════════════════════════ */

const socket = io();

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

// ─── Événements Socket.IO ────────────────────────────────────

socket.on("new_message", ({ pseudo, content, time }) => {
  appendMessage(pseudo, content, time, pseudo === MY_PSEUDO);
});

socket.on("system_message", ({ text }) => appendSystem(text));

socket.on("user_list", (users) => {
  const ul = document.getElementById("user-list");
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
});

scrollBottom();

// ─── WebRTC ──────────────────────────────────────────────────

let localStream = null;
let peerConnections = {};
let inCall = false;
let isMuted = false;

const ICE_SERVERS = {
  iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
};

// ── Sélecteur de micro ───────────────────────────────────────

async function populateMicList() {
  const select = document.getElementById("mic-select");
  try {
    // Demander la permission d'abord pour obtenir les labels
    await navigator.mediaDevices.getUserMedia({ audio: true });
    const devices = await navigator.mediaDevices.enumerateDevices();
    const mics = devices.filter((d) => d.kind === "audioinput");
    select.innerHTML = "";
    mics.forEach((mic, i) => {
      const opt = document.createElement("option");
      opt.value = mic.deviceId;
      opt.textContent = mic.label || `Micro ${i + 1}`;
      select.appendChild(opt);
    });
  } catch (err) {
    console.warn("Impossible de lister les micros :", err);
  }
}

// Rafraîchir si un périphérique est branché/débranché
navigator.mediaDevices.addEventListener("devicechange", populateMicList);

// Remplir au chargement de la page
populateMicList();

// Changer de micro en cours d'appel
document.getElementById("mic-select").addEventListener("change", async () => {
  if (!inCall) return;
  await restartLocalStream();
});

async function getLocalStream() {
  const deviceId = document.getElementById("mic-select").value;
  const constraints = {
    audio: deviceId ? { deviceId: { exact: deviceId } } : true,
    video: false,
  };
  return navigator.mediaDevices.getUserMedia(constraints);
}

async function restartLocalStream() {
  // Arrêter l'ancien stream
  if (localStream) localStream.getTracks().forEach((t) => t.stop());
  localStream = await getLocalStream();

  // Appliquer le mute actuel
  localStream.getAudioTracks().forEach((t) => (t.enabled = !isMuted));

  // Remplacer la piste dans toutes les connexions existantes
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
  const btn = document.getElementById("mute-btn");
  btn.classList.toggle("muted", isMuted);
  btn.title = isMuted ? "Réactiver le micro" : "Couper le micro";
  btn.innerHTML = isMuted ? "🔇" : "🎤";
}

// ── Rejoindre / Quitter ──────────────────────────────────────

function toggleVoice() {
  if (!inCall) joinVoice();
  else leaveVoice();
}

async function joinVoice() {
  try {
    localStream = await getLocalStream();
    inCall = true;
    isMuted = false;

    document.getElementById("voice-btn").classList.add("active");
    document.getElementById("voice-label").textContent = "Raccrocher";
    document.getElementById("mute-btn").style.display = "flex";
    document.getElementById("mute-btn").innerHTML = "🎤";
    document.getElementById("mute-btn").classList.remove("muted");

    socket.emit("get_peers");
  } catch (err) {
    alert("Impossible d'accéder au micro : " + err.message);
  }
}

function leaveVoice() {
  inCall = false;
  isMuted = false;
  if (localStream) {
    localStream.getTracks().forEach((t) => t.stop());
    localStream = null;
  }
  Object.values(peerConnections).forEach((pc) => pc.close());
  peerConnections = {};
  document.getElementById("audio-container").innerHTML = "";
  document.getElementById("peer-audio-list").innerHTML = "";
  document.getElementById("voice-btn").classList.remove("active");
  document.getElementById("voice-label").textContent = "Rejoindre l'appel";
  document.getElementById("mute-btn").style.display = "none";
}

// ── Connexions WebRTC ────────────────────────────────────────

async function createPeerConnection(sid, pseudo, isInitiator) {
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
    if (["disconnected", "failed", "closed"].includes(pc.connectionState)) {
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

function addRemoteAudio(sid, pseudo, stream) {
  let audio = document.getElementById(`audio-${sid}`);
  if (!audio) {
    audio = document.createElement("audio");
    audio.id = `audio-${sid}`;
    audio.autoplay = true;
    document.getElementById("audio-container").appendChild(audio);
  }
  audio.srcObject = stream;

  if (!document.getElementById(`peer-${sid}`)) {
    const item = document.createElement("div");
    item.id = `peer-${sid}`;
    item.className = "peer-audio-item";
    item.innerHTML = `
      <div class="audio-wave">
        <span></span><span></span><span></span><span></span><span></span>
      </div>
      <span>${escapeHtml(pseudo)}</span>
    `;
    document.getElementById("peer-audio-list").appendChild(item);
  }
}

function removeRemoteAudio(sid) {
  document.getElementById(`audio-${sid}`)?.remove();
  document.getElementById(`peer-${sid}`)?.remove();
}

// ── Signaling ────────────────────────────────────────────────

socket.on("peer_list", async (peers) => {
  for (const peer of peers) {
    if (!peerConnections[peer.sid])
      await createPeerConnection(peer.sid, peer.pseudo, true);
  }
});

socket.on("webrtc_offer", async ({ offer, from, pseudo }) => {
  if (!inCall || peerConnections[from]) return;
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
    catch (_) { /* candidat périmé */ }
  }
});

window.addEventListener("beforeunload", leaveVoice);
