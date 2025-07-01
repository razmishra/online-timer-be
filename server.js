const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

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

// Helper function to generate unique IDs
function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).substr(2);
}

// Timer class for managing individual timers
class Timer {
  constructor(id, name, duration) {
    this.id = id;
    this.name = name;
    this.duration = duration; // in seconds
    this.remaining = duration;
    this.isRunning = false;
    this.startTime = null;
    this.message = '';
    this.backgroundColor = '#1f2937';
    this.textColor = '#ffffff';
    this.fontSize = 'text-6xl';
    this.isFlashing = false;
    this.connectedDevices = new Set(); // Track connected devices
    this.interval = null;
    this.controllerId = null;
  }

  start() {
    console.log(`Attempting to start timer ${this.id}: isRunning=${this.isRunning}, remaining=${this.remaining}`);
    if (!this.isRunning && this.remaining > 0) {
      this.isRunning = true;
      this.startTime = Date.now();
      this.interval = setInterval(() => this.update(), 1000);
      this.update();
      console.log(`Timer ${this.id} started successfully`);
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
      console.log(`Timer ${this.id} paused`);
    }
  }

  reset() {
    this.isRunning = false;
    this.remaining = this.duration;
    this.startTime = null;
    
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    
    this.update();
    console.log(`Timer ${this.id} reset`);
  }

  setDuration(duration) {
    this.duration = duration;
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
          const timerState = {
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
            connectedCount: this.connectedDevices.size
          };
          socket.emit('timer-update', timerState);
        } else {
          console.log(`Socket ${deviceId} not found, removing from connected devices`);
          this.connectedDevices.delete(deviceId);
        }
      }
    });
  }

  addDevice(deviceId) {
    if (this.connectedDevices.size < 3) {
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
      connectedCount: this.connectedDevices.size
    };
  }
}

// Helper function to ensure controller is connected to timer
function ensureControllerConnected(socket, timerId) {
  const timer = timers.get(timerId);
  if (timer && !timer.connectedDevices.has(socket.id)) {
    console.log(`Controller ${socket.id} not connected to timer ${timerId}, connecting now...`);
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
  console.log('Client connected:', socket.id);
  
  // Wait for client to request their timers (with controllerId)

  // --- JOIN TIMER ---
  socket.on('join-timer', ({ timerId, controllerId }) => {
    if (!controllerId) return;
    const timer = timers.get(timerId);
    if (timer && timer.controllerId === controllerId) {
      const wasAdded = timer.addDevice(socket.id);
      if (wasAdded) {
        deviceToTimer.set(socket.id, timerId);
      }
      const timerState = timer.getState();
      socket.emit('timer-joined', timerState);
      emitTimerListForController(socket, controllerId);
    } else {
      socket.emit('timer-not-found', { timerId });
    }
  });

  // --- CREATE TIMER ---
  socket.on('create-timer', ({ name, duration, controllerId }) => {
    if (!controllerId) return;
    const timerId = generateId();
    const timer = new Timer(timerId, name, duration);
    timer.controllerId = controllerId;
    timers.set(timerId, timer);
    if (!controllerTimers.has(controllerId)) controllerTimers.set(controllerId, new Set());
    controllerTimers.get(controllerId).add(timerId);
    timer.addDevice(socket.id);
    deviceToTimer.set(socket.id, timerId);
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

  socket.on('pause-timer', ({ timerId, controllerId }) => {
    if (!controllerId) return;
    const timer = timers.get(timerId);
    if (timer && timer.controllerId === controllerId) {
      timer.pause();
      emitTimerListForController(socket, controllerId);
    }
  });

  socket.on('reset-timer', ({ timerId, controllerId }) => {
    if (!controllerId) return;
    const timer = timers.get(timerId);
    if (timer && timer.controllerId === controllerId) {
      timer.reset();
      emitTimerListForController(socket, controllerId);
    }
  });

  socket.on('adjust-timer', ({ timerId, seconds, controllerId }) => {
    if (!controllerId) return;
    const timer = timers.get(timerId);
    if (timer && timer.controllerId === controllerId) {
      timer.adjustTime(seconds);
      emitTimerListForController(socket, controllerId);
    }
  });

  socket.on('update-message', ({ timerId, message, controllerId }) => {
    if (!controllerId) return;
    const timer = timers.get(timerId);
    if (timer && timer.controllerId === controllerId) {
      timer.updateMessage(message);
      emitTimerListForController(socket, controllerId);
    }
  });

  socket.on('clear-message', ({ timerId, controllerId }) => {
    if (!controllerId) return;
    const timer = timers.get(timerId);
    if (timer && timer.controllerId === controllerId) {
      timer.clearMessage();
      emitTimerListForController(socket, controllerId);
    }
  });

  socket.on('update-styling', ({ timerId, styling, controllerId }) => {
    if (!controllerId) return;
    const timer = timers.get(timerId);
    if (timer && timer.controllerId === controllerId) {
      timer.updateStyling(styling);
      emitTimerListForController(socket, controllerId);
    }
  });

  socket.on('toggle-flash', ({ timerId, isFlashing, controllerId }) => {
    if (!controllerId) return;
    const timer = timers.get(timerId);
    if (timer && timer.controllerId === controllerId) {
      timer.toggleFlash(isFlashing);
      emitTimerListForController(socket, controllerId);
    }
  });

  // Handle disconnection
  socket.on('disconnect', () => {
    const timerId = deviceToTimer.get(socket.id);
    if (timerId) {
      const timer = timers.get(timerId);
      if (timer) {
        timer.removeDevice(socket.id);
      }
      deviceToTimer.delete(socket.id);
    }
  });
});

const port = process.env.PORT || 3001;

server.listen(port, () => {
  console.log(`> Socket.IO Server ready on port ${port}`);
  console.log(`> Health check available at http://localhost:${port}/health`);
}); 