import os
import json
from flask import Flask, render_template, request, session, redirect, url_for, jsonify
from flask_socketio import SocketIO, emit, join_room, leave_room
from supabase import create_client, Client
from datetime import datetime
import hashlib

app = Flask(__name__)
app.secret_key = os.environ.get("SECRET_KEY", "dev-secret-change-in-prod")

# Configuration Supabase
SUPABASE_URL = os.environ.get("SUPABASE_URL", "")
SUPABASE_KEY = os.environ.get("SUPABASE_ANON_KEY", "")

supabase: Client = create_client(SUPABASE_URL, SUPABASE_KEY) if SUPABASE_URL else None

# Mot de passe du salon (hashé)
SALON_PASSWORD = os.environ.get("SALON_PASSWORD", "monmotdepasse")

# Utilisateurs connectés en mémoire (sid -> pseudo)
connected_users = {}

socketio = SocketIO(app, cors_allowed_origins="*", async_mode="gevent")

ROOM = "salon_principal"


def hash_password(password):
    return hashlib.sha256(password.encode()).hexdigest()


def get_messages(limit=50):
    """Récupère les derniers messages depuis Supabase"""
    if not supabase:
        return []
    try:
        response = (
            supabase.table("messages")
            .select("*")
            .order("created_at", desc=False)
            .limit(limit)
            .execute()
        )
        return response.data
    except Exception as e:
        print(f"Erreur Supabase: {e}")
        return []


def save_message(pseudo, content):
    """Sauvegarde un message dans Supabase"""
    if not supabase:
        return None
    try:
        response = (
            supabase.table("messages")
            .insert({"pseudo": pseudo, "content": content})
            .execute()
        )
        return response.data
    except Exception as e:
        print(f"Erreur sauvegarde message: {e}")
        return None


# ─── Routes HTTP ───────────────────────────────────────────────

@app.route("/", methods=["GET", "POST"])
def login():
    if request.method == "POST":
        pseudo = request.form.get("pseudo", "").strip()
        password = request.form.get("password", "").strip()

        if not pseudo or len(pseudo) < 2:
            return render_template("login.html", error="Pseudo trop court (min 2 caractères)")

        if len(pseudo) > 20:
            return render_template("login.html", error="Pseudo trop long (max 20 caractères)")

        if password != SALON_PASSWORD:
            return render_template("login.html", error="Mot de passe incorrect")

        # Vérifier pseudo unique
        if pseudo in connected_users.values():
            return render_template("login.html", error="Ce pseudo est déjà utilisé")

        session["pseudo"] = pseudo
        return redirect(url_for("chat"))

    if "pseudo" in session:
        return redirect(url_for("chat"))

    return render_template("login.html")


@app.route("/chat")
def chat():
    if "pseudo" not in session:
        return redirect(url_for("login"))
    messages = get_messages()
    return render_template("chat.html", pseudo=session["pseudo"], messages=messages)


@app.route("/logout")
def logout():
    session.pop("pseudo", None)
    return redirect(url_for("login"))


# ─── Socket.IO Events ─────────────────────────────────────────

@socketio.on("connect")
def on_connect():
    pseudo = session.get("pseudo")
    if not pseudo:
        return False  # Refuse la connexion
    connected_users[request.sid] = pseudo
    join_room(ROOM)
    emit("user_list", list(connected_users.values()), room=ROOM)
    emit("system_message", {"text": f"✦ {pseudo} a rejoint le salon"}, room=ROOM)
    print(f"[+] {pseudo} connecté ({request.sid})")


@socketio.on("disconnect")
def on_disconnect():
    pseudo = connected_users.pop(request.sid, None)
    if pseudo:
        leave_room(ROOM)
        emit("user_list", list(connected_users.values()), room=ROOM)
        emit("system_message", {"text": f"✦ {pseudo} a quitté le salon"}, room=ROOM)
        print(f"[-] {pseudo} déconnecté")


@socketio.on("send_message")
def on_message(data):
    pseudo = connected_users.get(request.sid)
    if not pseudo:
        return
    content = data.get("content", "").strip()
    if not content or len(content) > 1000:
        return

    now = datetime.utcnow().strftime("%H:%M")
    save_message(pseudo, content)

    emit(
        "new_message",
        {"pseudo": pseudo, "content": content, "time": now},
        room=ROOM,
    )


# ─── WebRTC Signaling ─────────────────────────────────────────

@socketio.on("webrtc_offer")
def on_offer(data):
    """Relaie une offre WebRTC à un pair spécifique"""
    target_sid = data.get("target")
    emit("webrtc_offer", {
        "offer": data.get("offer"),
        "from": request.sid,
        "pseudo": connected_users.get(request.sid)
    }, to=target_sid)


@socketio.on("webrtc_answer")
def on_answer(data):
    """Relaie une réponse WebRTC"""
    target_sid = data.get("target")
    emit("webrtc_answer", {
        "answer": data.get("answer"),
        "from": request.sid
    }, to=target_sid)


@socketio.on("webrtc_ice")
def on_ice(data):
    """Relaie les candidats ICE"""
    target_sid = data.get("target")
    emit("webrtc_ice", {
        "candidate": data.get("candidate"),
        "from": request.sid
    }, to=target_sid)


@socketio.on("get_peers")
def on_get_peers():
    """Retourne la liste des SIDs connectés pour établir des connexions WebRTC"""
    peers = [
        {"sid": sid, "pseudo": pseudo}
        for sid, pseudo in connected_users.items()
        if sid != request.sid
    ]
    emit("peer_list", peers)


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    socketio.run(app, host="0.0.0.0", port=port, debug=False)
