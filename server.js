const express = require("express");
const { createServer } = require("http");
const { Server } = require("socket.io");
const cors = require("cors");

const app = express();
const server = createServer(app);

// Enable CORS
app.use(cors({
  origin: process.env.FRONTEND_URL || "http://localhost:3000",
  credentials: true
}));

// Create Socket.IO server
const io = new Server(server, {
  cors: {
    origin: process.env.FRONTEND_URL || "http://localhost:3000",
    credentials: true
  }
});

// Global variables
const timers = new Map(); // timerId -> Timer instance
const deviceToTimer = new Map(); // deviceId -> timerId
const controllerTimers = new Map(); // controllerId -> Set of timerIds
const controllerToSocket = new Map(); // controllerId -> Set of socketIds

// Helper function to generate unique IDs
function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).substr(2);
}

// Timer class for managing individual timers
class Timer {
  constructor(id, name, duration, maxConnectionsAllowed, maxTimersAllowed) {
    this.id = id;
    this.name = name;
    this.duration = duration; // in seconds
    this.originalDuration = duration; // Store the original duration for reset
    this.remaining = duration;
    this.isRunning = false;
    this.maxConnectionsAllowed = maxConnectionsAllowed ?? 4;
    this.maxTimersAllowed = maxTimersAllowed ?? 3;
    this.startTime = null;
    this.message = '';
    this.backgroundColor = '#1f2937';
    this.textColor = '#ffffff';
    this.fontSize = 'text-6xl';
    this.isFlashing = false;
    this.connectedDevices = new Set(); // Track connected devices
    this.interval = null;
    this.controllerId = null;
    this.timerView = 'normal';
  }

  start() {
    if (!this.isRunning && this.remaining > 0) {
      this.isRunning = true;
      this.startTime = Date.now();
      this.interval = setInterval(() => this.update(), 1000);
      this.update();
    } else {
      console.log(`Timer ${this.id} start failed: isRunning=${this.isRunning}, remaining=${this.remaining}`);
    }
  }

  pause() {
    if (this.isRunning) {
      this.isRunning = false;
      const elapsed = Math.floor((Date.now() - this.startTime) / 1000);
      this.remaining = this.duration - elapsed;
      this.duration = Math.abs(this.remaining);
      
      if (this.interval) {
        clearInterval(this.interval);
        this.interval = null;
      }
      
      this.update();
    }
  }

  reset() {
    this.isRunning = false;
    this.duration = this.originalDuration; // Restore to original duration
    this.remaining = this.originalDuration;
    this.startTime = null;
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    this.update();
  }

  setDuration(duration) {
    this.duration = duration;
    this.originalDuration = duration; // Update original duration on set
    this.remaining = duration;
    this.isRunning = false;
    this.startTime = null;
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    this.update();
  }

  adjustTime(seconds) {
    const newDuration = Math.max(0, this.duration + seconds);
    if (this.isRunning) {
      // Calculate elapsed time
      const elapsed = Math.floor((Date.now() - this.startTime) / 1000);
      // Update duration
      this.duration = newDuration;
      // Update remaining based on new duration and elapsed
      this.remaining = Math.max(0, this.duration - elapsed);
      // If timer already finished, stop it
      if (this.remaining <= 0) {
        this.isRunning = false;
        if (this.interval) {
          clearInterval(this.interval);
          this.interval = null;
        }
        this.startTime = null;
      }
      this.update();
    } else {
      this.setDuration(newDuration);
    }
  }

  update() {
    if (this.isRunning && this.startTime) {
      const elapsed = Math.floor((Date.now() - this.startTime) / 1000);
      this.remaining = this.duration - elapsed;
    }
    
    // Emit to all connected devices for this timer
    this.connectedDevices.forEach(deviceId => {
      if (io && io.sockets && io.sockets.sockets) {
        const socket = io.sockets.sockets.get(deviceId);
        if (socket) {
          const timerState = this.getState();
          socket.emit('timer-update', timerState);
        } else {
          this.connectedDevices.delete(deviceId);
        }
      }
    });
  }

  addDevice(deviceId) {
    if (this.connectedDevices.size < this.maxConnectionsAllowed) {
      this.connectedDevices.add(deviceId);
      this.update();
      return true;
    }
    return false;
  }

  removeDevice(deviceId) {
    this.connectedDevices.delete(deviceId);
    this.update();
  }

  updateMessage(message) {
    this.message = message;
    this.update();
  }

  clearMessage() {
    this.message = '';
    this.update();
  }

  updateStyling(styling) {
    this.backgroundColor = styling.backgroundColor || this.backgroundColor;
    this.textColor = styling.textColor || this.textColor;
    this.fontSize = styling.fontSize || this.fontSize;
    this.timerView = styling.timerView || this.timerView;
    this.update();
  }

  toggleFlash(isFlashing) {
    this.isFlashing = isFlashing;
    this.update();
  }

  getState() {
    return {
      id: this.id,
      name: this.name,
      duration: this.duration,
      remaining: this.remaining,
      isRunning: this.isRunning,
      message: this.message,
      backgroundColor: this.backgroundColor,
      textColor: this.textColor,
      fontSize: this.fontSize,
      isFlashing: this.isFlashing,
      connectedCount: this.connectedDevices.size,
      styling: {
        backgroundColor: this.backgroundColor,
        textColor: this.textColor,
        fontSize: this.fontSize,
        timerView: this.timerView || "normal",
      },
    };
  }
}

// Helper function to ensure controller is connected to timer
function ensureControllerConnected(socket, timerId) {
  const timer = timers.get(timerId);
  if (timer && !timer.connectedDevices.has(socket.id)) {
    timer.addDevice(socket.id);
    deviceToTimer.set(socket.id, timerId);
  }
}

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    timers: timers.size,
    connectedDevices: Array.from(deviceToTimer.keys()).length
  });
});

// Helper: get timers for a controller
function getTimersForController(controllerId) {
  const timerIds = controllerTimers.get(controllerId) || new Set();
  return Array.from(timerIds).map(id => {
    const timer = timers.get(id);
    if (!timer) return null;
    return {
      id: timer.id,
      name: timer.name,
      duration: timer.duration,
      connectedCount: timer.connectedDevices.size
    };
  }).filter(Boolean);
}

// Helper: emit timer-list only for the requesting controller
function emitTimerListForController(socket, controllerId) {
  socket.emit('timer-list', getTimersForController(controllerId));
}

// Socket.IO connection handling
io.on('connection', (socket) => {
  // console.log('Client connected:', socket.id);

    // --- JOIN TIMER ---
  // Modified join-timer event handler to update controllerToSocket and emit limit-exceeded to controller
socket.on('join-timer', ({ timerId, controllerId, maxConnectionsAllowed }) => {
  if (!controllerId) return;
  const timer = timers.get(timerId);
  if (timer) {
    timer.maxConnectionsAllowed = maxConnectionsAllowed ?? timer.maxConnectionsAllowed;
    const wasAdded = timer.addDevice(socket.id);
    if (wasAdded) {
      deviceToTimer.set(socket.id, timerId);
      // Update controllerToSocket mapping
      if (!controllerToSocket.has(controllerId)) {
        controllerToSocket.set(controllerId, new Set());
      }
      controllerToSocket.get(controllerId).add(socket.id);

      const timerState = timer.getState();
      socket.emit('timer-joined', timerState);
      if (timer.controllerId === controllerId) {
        emitTimerListForController(socket, controllerId);
      }
    } else {
      socket.emit('timer-full', { timerId, failedSocketId: socket.id, isgood: false });

      // Emit limit-exceeded to controller's socket(s) using controllerToSocket
      const controllerSocketIds = controllerToSocket.get(timer.controllerId) || new Set();
      controllerSocketIds.forEach((controllerSocketId) => {
        const controllerSocket = io.sockets.sockets.get(controllerSocketId);
        if (controllerSocket) {
          controllerSocket.emit('limit-exceeded', {
            timerId,
            type: 'viewers',
            message: `You've reached the maximum number of viewers (${timer.maxConnectionsAllowed}) for your plan. Upgrade to allow more viewers.`,
          });
        }
      });
    }
  } else {
    socket.emit('timer-not-found', { timerId });
  }
});

// Modified view-timer event handler to update controllerToSocket and emit limit-exceeded to controller
socket.on('view-timer', ({ timerId, controllerId, maxConnectionsAllowed }) => {
  if (!controllerId) return;
  const timer = timers.get(timerId);
  if (timer) {
    timer.maxConnectionsAllowed = maxConnectionsAllowed ?? timer.maxConnectionsAllowed;
    const wasAdded = timer.addDevice(socket.id);
    if (wasAdded) {
      deviceToTimer.set(socket.id, timerId);
      // Update controllerToSocket mapping
      if (!controllerToSocket.has(controllerId)) {
        controllerToSocket.set(controllerId, new Set());
      }
      controllerToSocket.get(controllerId).add(socket.id);

      const timerState = timer.getState();
      socket.emit('timer-joined', timerState);
    } else {
      socket.emit('timer-full', { timerId, failedSocketId: socket.id, isgood: true });

      // Emit limit-exceeded to controller's socket(s) using controllerToSocket
      const controllerSocketIds = controllerToSocket.get(timer.controllerId) || new Set();
      controllerSocketIds.forEach((controllerSocketId) => {
        const controllerSocket = io.sockets.sockets.get(controllerSocketId);
        if (controllerSocket) {
          controllerSocket.emit('limit-exceeded', {
            timerId,
            type: 'viewers',
            message: `You've reached the maximum number of viewers (${timer.maxConnectionsAllowed-1}) for your plan. Upgrade to allow more viewers.`,
          });
        }
      });
    }
  } else {
    socket.emit('timer-not-found', { timerId });
  }
});

// Modified create-timer event handler to update controllerToSocket
socket.on('create-timer', ({ name, duration, maxConnectionsAllowed = 4, maxTimersAllowed = 3, controllerId, styling }) => {
  if (!controllerId) return;
  const currentTimers = controllerTimers.get(controllerId) || new Set();
  if (currentTimers.size >= maxTimersAllowed) {
    socket.emit('limit-exceeded', {
      type: 'timers',
      message: `You've reached the maximum number of timers (${maxTimersAllowed}) for your plan. Upgrade to create more timers.`,
    });
    return;
  }
  const timerId = generateId();
  const timer = new Timer(timerId, name, duration, maxConnectionsAllowed, maxTimersAllowed);
  timer.controllerId = controllerId;
  if (styling) {
    timer.backgroundColor = styling.backgroundColor || timer.backgroundColor;
    timer.textColor = styling.textColor || timer.textColor;
    timer.fontSize = styling.fontSize || timer.fontSize;
    timer.timerView = styling.timerView || 'normal';
  }
  timers.set(timerId, timer);
  if (!controllerTimers.has(controllerId)) controllerTimers.set(controllerId, new Set());
  controllerTimers.get(controllerId).add(timerId);
  timer.addDevice(socket.id);
  deviceToTimer.set(socket.id, timerId);
  // Update controllerToSocket mapping
  if (!controllerToSocket.has(controllerId)) {
    controllerToSocket.set(controllerId, new Set());
  }
  controllerToSocket.get(controllerId).add(socket.id);

  emitTimerListForController(socket, controllerId);
  socket.emit('timer-created', timer.getState());
});

  // --- LIST TIMERS FOR CONTROLLER ---
  socket.on('get-timers', ({ controllerId }) => {
    if (!controllerId) return;
    emitTimerListForController(socket, controllerId);
  });

  // --- DELETE TIMER ---
  socket.on('delete-timer', ({ timerId, controllerId }) => {
    if (!controllerId) return;
    const timer = timers.get(timerId);
    if (timer && timer.controllerId === controllerId) {
      timer.connectedDevices.forEach(deviceId => {
        const deviceSocket = io.sockets.sockets.get(deviceId);
        if (deviceSocket) {
          deviceSocket.emit('timer-deleted', { timerId });
        }
        deviceToTimer.delete(deviceId);
      });
      if (timer.interval) {
        clearInterval(timer.interval);
      }
      timers.delete(timerId);
      if (controllerTimers.has(controllerId)) controllerTimers.get(controllerId).delete(timerId);
      emitTimerListForController(socket, controllerId);
    }
  });

  // --- TIMER CONTROLS (all require controllerId) ---
  socket.on('set-timer', ({ timerId, duration, controllerId }) => {
    if (!controllerId) return;
    const timer = timers.get(timerId);
    if (timer && timer.controllerId === controllerId) {
      timer.setDuration(duration);
      emitTimerListForController(socket, controllerId);
    }
  });

  socket.on('start-timer', ({ timerId, controllerId }) => {
    if (!controllerId) return;
    const timer = timers.get(timerId);
    if (timer && timer.controllerId === controllerId) {
      timer.start();
      emitTimerListForController(socket, controllerId);
    }
  });

  socket.on("pause-timer", ({ timerId, controllerId }) => {
    if (!controllerId) return;
    const timer = timers.get(timerId);
    if (timer && timer.controllerId === controllerId) {
      timer.pause();
      emitTimerListForController(socket, controllerId);
    }
  });

  socket.on("reset-timer", ({ timerId, controllerId }) => {
    if (!controllerId) return;
    const timer = timers.get(timerId);
    if (timer && timer.controllerId === controllerId) {
      timer.reset();
      emitTimerListForController(socket, controllerId);
    }
  });

  socket.on("adjust-timer", ({ timerId, seconds, controllerId }) => {
    if (!controllerId) return;
    const timer = timers.get(timerId);
    if (timer && timer.controllerId === controllerId) {
      timer.adjustTime(seconds);
      emitTimerListForController(socket, controllerId);
    }
  });

  socket.on("update-message", ({ timerId, message, controllerId }) => {
    if (!controllerId) return;
    const timer = timers.get(timerId);
    if (timer && timer.controllerId === controllerId) {
      timer.updateMessage(message);
      emitTimerListForController(socket, controllerId);
    }
  });

  socket.on("clear-message", ({ timerId, controllerId }) => {
    if (!controllerId) return;
    const timer = timers.get(timerId);
    if (timer && timer.controllerId === controllerId) {
      timer.clearMessage();
      emitTimerListForController(socket, controllerId);
    }
  });

  socket.on("update-styling", ({ timerId, styling, controllerId }) => {
    if (!controllerId) return;
    const timer = timers.get(timerId);
    if (timer && timer.controllerId === controllerId) {
      timer.updateStyling(styling);
      emitTimerListForController(socket, controllerId);
    }
  });

  socket.on("toggle-flash", ({ timerId, isFlashing, controllerId }) => {
    if (!controllerId) return;
    const timer = timers.get(timerId);
    if (timer && timer.controllerId === controllerId) {
      timer.toggleFlash(isFlashing);
      emitTimerListForController(socket, controllerId);
    }
  });

  // Modified disconnect event handler to clean up controllerToSocket
  socket.on('disconnect', () => {
    const timerId = deviceToTimer.get(socket.id);
    if (timerId) {
      const timer = timers.get(timerId);
      if (timer) {
        timer.removeDevice(socket.id);
      }
      deviceToTimer.delete(socket.id);
    }
    // Clean up controllerToSocket mapping
    controllerToSocket.forEach((socketIds, controllerId) => {
      if (socketIds.has(socket.id)) {
        socketIds.delete(socket.id);
        if (socketIds.size === 0) {
          controllerToSocket.delete(controllerId);
        }
      }
    });
  });

});

const port = process.env.PORT || 3001;

server.listen(port, () => {
  console.log(`> Socket.IO Server ready on port ${port}`);
  console.log(`> Health check available at http://localhost:${port}/health`);
});