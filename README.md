# 🎮 Spielhalle — Deployment Guide

## Projektstruktur
```
spielhalle/
├── server.js          ← Backend (Node.js + Socket.io)
├── package.json       ← Dependencies
└── public/
    └── index.html     ← Frontend (alles in einer Datei)
```

---

## 🚀 Option 1: Railway.app (Empfohlen — kostenlos)

1. **Account erstellen** → https://railway.app (mit GitHub anmelden)

2. **GitHub Repository erstellen**
   - Gehe zu https://github.com/new
   - Name: `spielhalle`
   - Public oder Private — egal
   - Repository erstellen

3. **Dateien hochladen**
   - Lade alle 3 Dateien hoch: `server.js`, `package.json`, `public/index.html`
   - Oder: nutze Git:
     ```bash
     git init
     git add .
     git commit -m "Spielhalle"
     git remote add origin https://github.com/DEIN-NAME/spielhalle.git
     git push -u origin main
     ```

4. **Railway deployen**
   - Gehe zu https://railway.app/dashboard
   - Klicke „New Project" → „Deploy from GitHub repo"
   - Wähle dein `spielhalle` Repository
   - Railway erkennt Node.js automatisch
   - Nach ~1 Minute: **deine URL erscheint** (z.B. `spielhalle-xyz.up.railway.app`)

5. **Fertig!** Teile die URL mit Freunden.

---

## 🌐 Option 2: Render.com (Alternativ — kostenlos)

1. Account bei https://render.com erstellen
2. „New" → „Web Service"
3. GitHub Repo verbinden
4. Einstellungen:
   - **Build Command:** `npm install`
   - **Start Command:** `node server.js`
   - **Environment:** Node
5. „Create Web Service" klicken
6. URL erscheint nach dem Build (~2 Minuten)

---

## 💻 Lokal testen (optional)

```bash
# Node.js installieren: https://nodejs.org

cd spielhalle
npm install
node server.js

# Öffne: http://localhost:3000
```

---

## ✅ Features

- **Eindeutige Spielernamen** — Server prüft ob Name bereits vergeben
- **Offline vs KI** — Tic Tac Toe (Minimax) + Schach (Minimax + Alpha-Beta)
- **Online Matchmaking** — Automatisch Gegner suchen per Warteschlange
- **Freundesliste** — Freunde hinzufügen, Anfragen annehmen/ablehnen
- **Direktes Herausfordern** — Freunde oder andere Online-Spieler herausfordern
- **Echtzeit** — Alle Züge live über Socket.io
- **Automatischer Disconnect-Schutz** — Gegner verlässt = Nachricht + Rückkehr zum Menü

---

## ⚠️ Hinweise

- Der kostenlose Tier bei Railway/Render schläft nach Inaktivität ein (~30 Sek. Wartezeit beim ersten Aufruf)
- Für dauerhaften Betrieb: kostenpflichtiger Plan (~5$/Monat)
- Daten (Nutzer, Spiele) werden bei Server-Neustart zurückgesetzt — alles läuft im RAM
- Für persistente Daten (Freunde dauerhaft speichern etc.) wäre eine Datenbank nötig (z.B. MongoDB Atlas)
