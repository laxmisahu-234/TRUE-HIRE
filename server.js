const express = require("express");
const http = require("http");
const mongoose = require("mongoose");
const cors = require("cors");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const { Server } = require("socket.io");
const { v4: uuidv4 } = require("uuid");

const JWT_SECRET = "truehire_secret_key";

const app = express();
const server = http.createServer(app);

app.use(cors());
app.use(express.json());

/* ===============================
   DATABASE
================================= */

mongoose.connect("mongodb://127.0.0.1:27017/truehire")
  .then(() => console.log("MongoDB Connected"))
  .catch((err) => console.log(err));

/* ===============================
   MODELS
================================= */

const User = mongoose.model("User", {
  name: String,
  email: String,
  password: String,
  role: String,
});

const Interview = mongoose.model("Interview", {
  roomId: String,
  candidateName: String,
  candidateEmail: String,
  status: {
    type: String,
    default: "scheduled",
  },
  duration: {
    type: Number,
    default: 0,
  },
  score: Number,
  feedback: String,
  trustScore: Number,
  violations: Object
});

/* ===============================
   AUTH MIDDLEWARE
================================= */

function authMiddleware(req, res, next) {
  const token = req.headers.authorization;

  if (!token) return res.status(401).json({ message: "No token" });

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch {
    res.status(401).json({ message: "Invalid token" });
  }
}

/* ===============================
   AUTH ROUTES
================================= */

app.post("/register", async (req, res) => {
  const { name, email, password, role } = req.body;

  const existing = await User.findOne({ email });
  if (existing) return res.status(400).json({ message: "User exists" });

  const hashed = await bcrypt.hash(password, 10);

  await User.create({
    name,
    email,
    password: hashed,
    role,
  });

  res.json({ message: "Registered successfully" });
});

app.post("/login", async (req, res) => {
  const { email, password } = req.body;

  const user = await User.findOne({ email });
  if (!user) return res.status(400).json({ message: "User not found" });

  const match = await bcrypt.compare(password, user.password);
  if (!match) return res.status(400).json({ message: "Invalid password" });

  const token = jwt.sign(
    {
      id: user._id,
      email: user.email,
      role: user.role,
      name: user.name,
    },
    JWT_SECRET
  );

  res.json({ token, user });
});

/* ===============================
   INTERVIEW ROUTES
================================= */

app.post("/create-interview", authMiddleware, async (req, res) => {
  const { candidateName, candidateEmail } = req.body;

  const roomId = uuidv4();

  const interview = await Interview.create({
    roomId,
    candidateName,
    candidateEmail,
  });

  res.json(interview);
});

app.put("/start-interview/:roomId", authMiddleware, async (req, res) => {
  const interview = await Interview.findOneAndUpdate(
    { roomId: req.params.roomId },
    { status: "live" },
    { new: true }
  );

  io.to(req.params.roomId).emit("interview-started");

  res.json(interview);
});

app.put("/end-interview/:roomId", authMiddleware, async (req, res) => {
  const { duration } = req.body;

  const interview = await Interview.findOneAndUpdate(
    { roomId: req.params.roomId },
    { status: "completed", duration },
    { new: true }
  );

  console.log("Interview ended:", req.params.roomId);

  io.to(req.params.roomId).emit("interview-ended");

  res.json(interview);
});

app.get("/candidate-interviews", authMiddleware, async (req, res) => {
  const interviews = await Interview.find({
    candidateEmail: req.user.email,
  });

  res.json(interviews);
});

app.get("/interviewer-interviews", authMiddleware, async (req, res) => {
  const interviews = await Interview.find();
  res.json(interviews);
});

app.delete("/delete-interview/:roomId", authMiddleware, async (req, res) => {
  const deleted = await Interview.findOneAndDelete({
    roomId: req.params.roomId,
  });

  if (!deleted)
    return res.status(404).json({ message: "Interview not found" });

  res.json({ message: "Interview deleted successfully" });
});
app.post("/evaluate-interview", async (req, res) => {

  const { roomId, violations } = req.body;

  // ===== 1. BASE SCORE =====
  let score = 7;
  let feedback = "Good performance";

  // ===== 2. TRUST SCORE =====
  let trustScore = 100;

  if (violations?.tabSwitch) trustScore -= violations.tabSwitch * 10;
  if (violations?.fullscreen) trustScore -= violations.fullscreen * 15;
  if (violations?.copyPaste) trustScore -= violations.copyPaste * 20;

  trustScore = Math.max(trustScore, 0);

  // ===== 3. AI EXPLANATION (🔥 NEW PART) =====
  let aiExplanation = "";

  if (trustScore >= 80) {
    feedback = "Excellent performance";
    aiExplanation =
      "The candidate remained focused throughout the interview, maintained good discipline, and showed no suspicious behavior.";
  } 
  else if (trustScore >= 50) {
    feedback = "Average performance";
    aiExplanation =
      "The candidate performed reasonably well but showed minor distractions or occasional suspicious behavior.";
  } 
  else {
    feedback = "Poor performance";
    aiExplanation =
      "Multiple suspicious activities were detected during the interview, indicating possible lack of focus or rule violations.";
    score = 4;
  }

  // ===== 4. SAVE TO DATABASE =====
  const updated = await Interview.findOneAndUpdate(
    { roomId },
    {
      score,
      feedback,
      trustScore,
      aiExplanation, // 🔥 ADD THIS
      violations
    },
    { new: true }
  );

  res.json(updated);
});
/* ===============================
   SOCKET.IO
================================= */

const io = new Server(server, {
  cors: {
    origin: "http://localhost:3000",
    methods: ["GET", "POST", "PUT"],
  },
});

io.on("connection", (socket) => {
  console.log("User connected:", socket.id);

  /* ===============================
     JOIN ROOM
  =============================== */
  socket.on("join-room", ({ roomId, name, role }) => {

    socket.join(roomId);
    socket.on("chat-message", (data) => {
  socket.to(data.roomId).emit("chat-message", data);
});

    // store data for later use
    socket.data.name = name;
    socket.data.role = role;
    socket.data.roomId = roomId;

    const room = io.sockets.adapter.rooms.get(roomId);
    const size = room ? room.size : 0;

    console.log("Room size:", size);

    // notify others that user joined
    socket.to(roomId).emit("user-joined", {
      name,
      role,
    });

    // send existing users to new user
    const clients = Array.from(room || []);
    clients.forEach((clientId) => {
      if (clientId !== socket.id) {
        const clientSocket = io.sockets.sockets.get(clientId);
        if (clientSocket) {
          socket.emit("user-joined", {
            name: clientSocket.data.name,
            role: clientSocket.data.role,
          });
        }
      }
    });

    // start WebRTC when 2 users are present
    if (size === 2) {
  socket.to(roomId).emit("create-offer");
}
  });

  /* ===============================
     USER LEAVES ROOM
  =============================== */
  socket.on("leave-room", ({ roomId, name }) => {

    socket.to(roomId).emit("user-left", { name });

  });

  /* ===============================
     WEBRTC SIGNALING
  =============================== */

  socket.on("offer", (data) => {
    socket.to(data.roomId).emit("offer", data.offer);
  });

  socket.on("answer", (data) => {
    socket.to(data.roomId).emit("answer", data.answer);
  });

  socket.on("ice-candidate", (data) => {
    socket.to(data.roomId).emit("ice-candidate", data.candidate);
  });

  /* ===============================
     DISCONNECT HANDLER
  =============================== */

  socket.on("disconnect", () => {

    const roomId = socket.data.roomId;
    const name = socket.data.name;

    if (roomId && name) {
      socket.to(roomId).emit("user-left", { name });
    }

    console.log("User disconnected:", socket.id);
  });

});
/* ===============================
   START SERVER
================================= */

server.listen(5000, () => {
  console.log("Server running on port 5000");
});
const multer = require("multer");

const storage = multer.diskStorage({
  destination: "recordings/",
  filename: (req, file, cb) => {
    cb(null, Date.now() + ".webm");
  },
});

const upload = multer({ storage });

app.post("/upload", upload.single("file"), (req, res) => {
  res.json({ message: "Recording saved" });
});