const express = require("express");
const http = require("http");
const socketIo = require("socket.io");
const cors = require("cors");
const { v4: uuidv4 } = require("uuid");

const app = express();
const server = http.createServer(app);

// Configure CORS for both Express and Socket.IO
app.use(
  cors({
    origin: [
      "https://basedfrenzy.com",
      "https://play.basedfrenzy.com",
      "https://gameverse.basedfrenzy.com",
      "http://localhost:3000",
      "http://localhost:5173",
    ], // Add your frontend URLs
    credentials: true,
  })
);

const io = socketIo(server, {
  cors: {
    origin: [
      "https://basedfrenzy.com",
      "https://play.basedfrenzy.com",
      "https://gameverse.basedfrenzy.com",
      "http://localhost:3000",
      "http://localhost:5173",
    ],
    methods: ["GET", "POST"],
    credentials: true,
  },
});

app.use(express.json());

// In-memory storage (in production, use a database)
let messages = [];
let connectedUsers = new Map(); // address -> user info
let userSockets = new Map(); // socketId -> user address
let playerInventories = new Map(); // address -> inventory data

// Rate limiting
const rateLimiter = new Map(); // address -> { messages: number, lastReset: timestamp }
const RATE_LIMIT_WINDOW = 60000; // 1 minute
const MAX_MESSAGES_PER_WINDOW = 30;

// Message history limit
const MAX_MESSAGES_HISTORY = 1000;

// Utility functions
const isValidAddress = (address) => {
  return (
    address &&
    typeof address === "string" &&
    address.match(/^0x[a-fA-F0-9]{40}$/)
  );
};

const isValidUsername = (username) => {
  return (
    username &&
    typeof username === "string" &&
    username.trim().length >= 3 &&
    username.trim().length <= 20 &&
    username.match(/^[a-zA-Z0-9_-]+$/)
  );
};

const sanitizeMessage = (message) => {
  return message.trim().substring(0, 500); // Max 500 characters
};

const checkRateLimit = (address) => {
  const now = Date.now();
  const userLimit = rateLimiter.get(address);

  if (!userLimit) {
    rateLimiter.set(address, { messages: 1, lastReset: now });
    return true;
  }

  // Reset if window expired
  if (now - userLimit.lastReset > RATE_LIMIT_WINDOW) {
    rateLimiter.set(address, { messages: 1, lastReset: now });
    return true;
  }

  // Check if under limit
  if (userLimit.messages < MAX_MESSAGES_PER_WINDOW) {
    userLimit.messages++;
    return true;
  }

  return false;
};

const addMessage = (address, username, message, replyTo = null) => {
  const newMessage = {
    id: uuidv4(),
    address,
    username,
    message: sanitizeMessage(message),
    timestamp: Date.now(),
    replyTo: replyTo
      ? {
          id: replyTo.id,
          username: replyTo.username,
          message: sanitizeMessage(replyTo.message),
        }
      : null,
  };

  messages.push(newMessage);

  // Trim messages if over limit
  if (messages.length > MAX_MESSAGES_HISTORY) {
    messages = messages.slice(-MAX_MESSAGES_HISTORY);
  }

  return newMessage;
};

const getOnlineUsers = () => {
  return Array.from(connectedUsers.values());
};

// Socket.IO connection handling
io.on("connection", (socket) => {
  console.log("New client connected:", socket.id);

  let userAddress = null;
  let username = null;

  // Handle authentication
  socket.on("authenticate", (auth) => {
    try {
      const { address, username: providedUsername } = auth;

      if (!isValidAddress(address)) {
        socket.emit("error", { message: "Invalid wallet address" });
        return;
      }

      if (!isValidUsername(providedUsername)) {
        socket.emit("error", {
          message:
            "Invalid username. Must be 3-20 characters, alphanumeric only.",
        });
        return;
      }

      // Check if address is already connected
      if (connectedUsers.has(address)) {
        socket.emit("error", {
          message: "Address already connected from another session",
        });
        return;
      }

      userAddress = address;
      username = providedUsername.trim();

      // Store user info
      const user = {
        address: userAddress,
        username: username,
        isOnline: true,
        joinedAt: Date.now(),
      };

      connectedUsers.set(userAddress, user);
      userSockets.set(socket.id, userAddress);

      // Send chat history to new user
      socket.emit("chatHistory", messages.slice(-50)); // Last 50 messages

      // Send current online users
      socket.emit("onlineUsers", getOnlineUsers());

      // Notify others of new user
      socket.broadcast.emit("userJoined", user);

      console.log(`User authenticated: ${username} (${userAddress})`);
    } catch (error) {
      console.error("Authentication error:", error);
      socket.emit("error", { message: "Authentication failed" });
    }
  });

  // Auto-authenticate if auth provided during connection
  if (
    socket.handshake.auth &&
    socket.handshake.auth.address &&
    socket.handshake.auth.username
  ) {
    socket.emit("authenticate", socket.handshake.auth);
    // Trigger authentication
    setTimeout(() => {
      const auth = socket.handshake.auth;
      socket.emit("authenticate", auth);

      try {
        const { address, username: providedUsername } = auth;

        if (!isValidAddress(address)) {
          socket.emit("error", { message: "Invalid wallet address" });
          return;
        }

        if (!isValidUsername(providedUsername)) {
          socket.emit("error", {
            message:
              "Invalid username. Must be 3-20 characters, alphanumeric only.",
          });
          return;
        }

        // Check if address is already connected
        if (connectedUsers.has(address)) {
          socket.emit("error", {
            message: "Address already connected from another session",
          });
          return;
        }

        userAddress = address;
        username = providedUsername.trim();

        // Store user info
        const user = {
          address: userAddress,
          username: username,
          isOnline: true,
          joinedAt: Date.now(),
        };

        connectedUsers.set(userAddress, user);
        userSockets.set(socket.id, userAddress);

        // Send chat history to new user
        socket.emit("chatHistory", messages.slice(-50)); // Last 50 messages

        // Send current online users
        socket.emit("onlineUsers", getOnlineUsers());

        // Notify others of new user
        socket.broadcast.emit("userJoined", user);

        console.log(`User authenticated: ${username} (${userAddress})`);
      } catch (error) {
        console.error("Auto-authentication error:", error);
        socket.emit("error", { message: "Authentication failed" });
      }
    }, 100);
  }

  // Handle new messages
  socket.on("sendMessage", (data) => {
    try {
      if (!userAddress || !username) {
        socket.emit("error", { message: "Not authenticated" });
        return;
      }

      const { message, replyTo } = data;

      if (!message || typeof message !== "string" || !message.trim()) {
        socket.emit("error", { message: "Invalid message" });
        return;
      }

      // Check rate limit
      if (!checkRateLimit(userAddress)) {
        socket.emit("error", {
          message: "Rate limit exceeded. Please slow down.",
        });
        return;
      }

      // Validate replyTo if provided
      let validatedReplyTo = null;
      if (replyTo) {
        if (replyTo.id && replyTo.username && replyTo.message) {
          validatedReplyTo = {
            id: replyTo.id,
            username: replyTo.username,
            message: replyTo.message,
          };
        }
      }

      // Add message
      const newMessage = addMessage(
        userAddress,
        username,
        message,
        validatedReplyTo
      );

      // Broadcast to all connected clients
      io.emit("message", newMessage);

      console.log(
        `Message from ${username}: ${message}${
          validatedReplyTo ? ` (replying to ${validatedReplyTo.username})` : ""
        }`
      );
    } catch (error) {
      console.error("Send message error:", error);
      socket.emit("error", { message: "Failed to send message" });
    }
  });

  // Handle disconnection
  socket.on("disconnect", () => {
    console.log("Client disconnected:", socket.id);

    if (userAddress) {
      // Remove user from connected users
      connectedUsers.delete(userAddress);
      userSockets.delete(socket.id);

      // Notify others of user leaving
      socket.broadcast.emit("userLeft", userAddress);

      console.log(`User disconnected: ${username} (${userAddress})`);
    }
  });

  // Handle errors
  socket.on("error", (error) => {
    console.error("Socket error:", error);
  });
});

// Game-specific endpoints

// Initialize player inventory if not exists
const initializePlayerInventory = (address) => {
  if (!playerInventories.has(address)) {
    playerInventories.set(address, {
      items: {},
      bait: 10,
      fishingRods: 1,
      money: 1000
    });
  }
  return playerInventories.get(address);
};

// Get player inventory
app.get("/api/inventory/:address", (req, res) => {
  const { address } = req.params;
  if (!isValidAddress(address)) {
    return res.status(400).json({ error: "Invalid address" });
  }
  
  const inventory = initializePlayerInventory(address);
  res.json(inventory);
});

// Fishing endpoint
app.post("/api/fishing/catch", (req, res) => {
  const { address } = req.body;
  
  if (!isValidAddress(address)) {
    return res.status(400).json({ error: "Invalid address" });
  }
  
  const inventory = initializePlayerInventory(address);
  
  // Check if player has bait
  if (inventory.bait <= 0) {
    return res.json({ 
      success: false, 
      message: "No bait available" 
    });
  }
  
  // Deduct bait
  inventory.bait--;
  
  // Simulate fishing
  const random = Math.random();
  const rodBreakChance = Math.random();
  
  // 5% chance of rod breaking
  const rodBroken = rodBreakChance < 0.05;
  if (rodBroken) {
    inventory.fishingRods = Math.max(0, inventory.fishingRods - 1);
  }
  
  let result = { success: false, rodBroken };
  
  // 10% chance of catching nothing
  if (random < 0.1) {
    result.message = rodBroken ? "Your fishing rod broke!" : "You didn't catch anything...";
  }
  // 60% common fish
  else if (random < 0.7) {
    const item = {
      id: 'common-fish',
      name: 'Common Fish',
      type: 'common',
      value: 10,
      description: 'A regular fish from the volcanic pool'
    };
    
    // Add to inventory
    if (!inventory.items[item.id]) {
      inventory.items[item.id] = { item, quantity: 0 };
    }
    inventory.items[item.id].quantity++;
    
    result = {
      success: true,
      item,
      rodBroken,
      message: rodBroken ? "You caught a fish but your rod broke!" : "You caught a Common Fish!"
    };
  }
  // 20% rare fish
  else if (random < 0.9) {
    const rareTypes = [
      { id: 'silver-fish', name: 'Silver Fish', value: 50 },
      { id: 'gold-fish', name: 'Gold Fish', value: 100 }
    ];
    const rare = rareTypes[Math.floor(Math.random() * rareTypes.length)];
    
    const item = {
      ...rare,
      type: 'rare',
      description: `A shiny ${rare.name.toLowerCase()} from the depths`
    };
    
    // Add to inventory
    if (!inventory.items[item.id]) {
      inventory.items[item.id] = { item, quantity: 0 };
    }
    inventory.items[item.id].quantity++;
    
    result = {
      success: true,
      item,
      rodBroken,
      message: `Amazing! You caught a ${rare.name}!${rodBroken ? " But your rod broke!" : ""}`
    };
  }
  // 10% epic/legendary
  else {
    const epicTypes = [
      { id: 'diamond-fish', name: 'Diamond Fish', type: 'epic', value: 500 },
      { id: 'mythril-fish', name: 'Mythril Fish', type: 'legendary', value: 1000 }
    ];
    const epic = epicTypes[Math.floor(Math.random() * epicTypes.length)];
    
    const item = {
      ...epic,
      description: `An extremely rare ${epic.name.toLowerCase()}!`
    };
    
    // Add to inventory
    if (!inventory.items[item.id]) {
      inventory.items[item.id] = { item, quantity: 0 };
    }
    inventory.items[item.id].quantity++;
    
    result = {
      success: true,
      item,
      rodBroken,
      message: `INCREDIBLE! You caught a ${epic.name}!${rodBroken ? " But your rod broke!" : ""}`
    };
  }
  
  // Save inventory
  playerInventories.set(address, inventory);
  
  // Emit inventory update if user is connected
  if (connectedUsers.has(address)) {
    io.to(address).emit('inventoryUpdate', inventory);
  }
  
  res.json(result);
});

// Sell items endpoint
app.post("/api/shop/sell", (req, res) => {
  const { address, itemId, quantity } = req.body;
  
  if (!isValidAddress(address)) {
    return res.status(400).json({ error: "Invalid address" });
  }
  
  const inventory = initializePlayerInventory(address);
  
  if (!inventory.items[itemId] || inventory.items[itemId].quantity < quantity) {
    return res.json({ success: false, message: "Not enough items" });
  }
  
  const item = inventory.items[itemId].item;
  const totalValue = item.value * quantity;
  
  // Update inventory
  inventory.items[itemId].quantity -= quantity;
  if (inventory.items[itemId].quantity <= 0) {
    delete inventory.items[itemId];
  }
  inventory.money += totalValue;
  
  // Save inventory
  playerInventories.set(address, inventory);
  
  // Emit inventory update if user is connected
  if (connectedUsers.has(address)) {
    io.to(address).emit('inventoryUpdate', inventory);
  }
  
  res.json({ success: true, money: totalValue });
});

// Buy bait endpoint
app.post("/api/shop/buy-bait", (req, res) => {
  const { address, quantity } = req.body;
  const baitPrice = 5; // $5 per bait
  
  if (!isValidAddress(address)) {
    return res.status(400).json({ error: "Invalid address" });
  }
  
  const inventory = initializePlayerInventory(address);
  const totalCost = baitPrice * quantity;
  
  if (inventory.money < totalCost) {
    return res.json({ success: false, message: "Not enough money" });
  }
  
  // Update inventory
  inventory.money -= totalCost;
  inventory.bait += quantity;
  
  // Save inventory
  playerInventories.set(address, inventory);
  
  // Emit inventory update if user is connected
  if (connectedUsers.has(address)) {
    io.to(address).emit('inventoryUpdate', inventory);
  }
  
  res.json({ success: true, bait: quantity, money: totalCost });
});

// Buy fishing rod endpoint
app.post("/api/shop/buy-rod", (req, res) => {
  const { address } = req.body;
  const rodPrice = 100; // $100 per rod
  
  if (!isValidAddress(address)) {
    return res.status(400).json({ error: "Invalid address" });
  }
  
  const inventory = initializePlayerInventory(address);
  
  if (inventory.money < rodPrice) {
    return res.json({ success: false, message: "Not enough money" });
  }
  
  // Update inventory
  inventory.money -= rodPrice;
  inventory.fishingRods++;
  
  // Save inventory
  playerInventories.set(address, inventory);
  
  // Emit inventory update if user is connected
  if (connectedUsers.has(address)) {
    io.to(address).emit('inventoryUpdate', inventory);
  }
  
  res.json({ success: true, rods: 1, money: rodPrice });
});

// REST API endpoints
app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    timestamp: Date.now(),
    connectedUsers: connectedUsers.size,
    totalMessages: messages.length,
    activePlayers: playerInventories.size,
  });
});

app.get("/api/stats", (req, res) => {
  res.json({
    connectedUsers: connectedUsers.size,
    totalMessages: messages.length,
    onlineUsers: getOnlineUsers().map((user) => ({
      username: user.username,
      joinedAt: user.joinedAt,
    })),
  });
});

// Cleanup function for rate limiter
setInterval(() => {
  const now = Date.now();
  for (const [address, limit] of rateLimiter.entries()) {
    if (now - limit.lastReset > RATE_LIMIT_WINDOW * 2) {
      rateLimiter.delete(address);
    }
  }
}, RATE_LIMIT_WINDOW);

const PORT = process.env.PORT || 3005;

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Socket.IO server ready for connections`);
});
