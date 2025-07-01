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
const timers = new Map();
const CONTROLLER_PASSWORD = process.env.CONTROLLER_PASSWORD || 'admin123';
let controllerSocketId = null;
const deviceToTimer = new Map(); // deviceId -> timerId
// const authenticatedControllers = new Set(); // Track authenticated controllers

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

// Socket.IO connection handling
io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);
  
  // Send available timers to new client
  const timerList = Array.from(timers.values()).map(timer => ({
    id: timer.id,
    name: timer.name,
    duration: timer.duration,
    connectedCount: timer.connectedDevices.size
  }));
  socket.emit('timer-list', timerList);

  // Controller authentication
  // socket.on('authenticate-controller', (password) => {
  //   console.log('Authentication attempt from:', socket.id, 'password:', password);
  //   console.log('Expected password:', CONTROLLER_PASSWORD);
  //   console.log('Password match:', password === CONTROLLER_PASSWORD);
  //   if (password === CONTROLLER_PASSWORD) {
  //     controllerSocketId = socket.id;
  //     authenticatedControllers.add(socket.id);
  //     socket.emit('controller-authenticated', true);
  //     console.log('Controller authenticated:', socket.id);
  //     console.log('controllerSocketId set to:', controllerSocketId);
  //     console.log('Authenticated controllers:', Array.from(authenticatedControllers));
  //   } else {
  //     socket.emit('controller-authenticated', false);
  //     console.log('Controller authentication failed:', socket.id);
  //   }
  // });

  // Join timer
  socket.on('join-timer', (timerId) => {
    // console.log('Join timer request:', socket.id, 'timerId:', timerId, 'Type:', typeof timerId);
    // console.log('Available timers:', Array.from(timers.keys()));
    // console.log(timers,"timers List")
    
    const timer = timers.get(timerId);
    if (timer) {
      // Always try to add the device, but don't fail if already connected
      const wasAdded = timer.addDevice(socket.id);
      if (wasAdded) {
        deviceToTimer.set(socket.id, timerId);
      }
      
      // Always send the timer state, even if already connected
      const timerState = timer.getState();
      // console.log(`Sending timer-joined to ${socket.id}:`, timerState);
      socket.emit('timer-joined', timerState);
      socket.emit('timer-list', Array.from(timers.values()).map(t => ({
        id: t.id,
        name: t.name,
        duration: t.duration,
        connectedCount: t.connectedDevices.size
      })));
      // console.log(`Device ${socket.id} joined timer ${timerId}`);
    } else {
      socket.emit('timer-not-found', { timerId });
      // console.log(`Timer ${timerId} not found`);
    }
  });

  // Create timer (controller only)
  socket.on('create-timer', (data) => {
    // console.log('Create timer request:', socket.id, 'data:', data);
    // if (authenticatedControllers.has(socket.id)) {
      const timerId = generateId();
      // console.log('Generated timer ID:', timerId, 'Type:', typeof timerId);
      const timer = new Timer(timerId, data.name, data.duration);
      timers.set(timerId, timer);
      // console.log('Timer stored with ID:', timerId);
      // console.log('Timers map keys:', Array.from(timers.keys()));
      
      // Automatically join the controller to the timer
      timer.addDevice(socket.id);
      deviceToTimer.set(socket.id, timerId);
      // console.log(`Controller ${socket.id} automatically joined timer ${timerId}`);
      
      // Send timer list to all clients
      const timerList = Array.from(timers.values()).map(timer => ({
        id: timer.id,
        name: timer.name,
        duration: timer.duration,
        connectedCount: timer.connectedDevices.size
      }));
      // console.log('Broadcasting updated timer list to all clients:', timerList);
      io.emit('timer-list', timerList);
      
      // Send the new timer to the creator
      socket.emit('timer-created', timer.getState());
      // console.log(`Timer created: ${timerId} - ${data.name}`);
    // } else {
    //   console.log('Unauthorized create-timer attempt from:', socket.id);
    // }
  });

  // Delete timer (controller only)
  socket.on('delete-timer', (timerId) => {
    // console.log('Delete timer request:', socket.id, 'timerId:', timerId);
    // if (authenticatedControllers.has(socket.id)) {
      const timer = timers.get(timerId);
      if (timer) {
        // Disconnect all devices
        timer.connectedDevices.forEach(deviceId => {
          const deviceSocket = io.sockets.sockets.get(deviceId);
          if (deviceSocket) {
            deviceSocket.emit('timer-deleted', { timerId });
          }
          deviceToTimer.delete(deviceId);
        });
        
        // Clear interval
        if (timer.interval) {
          clearInterval(timer.interval);
        }
        
        timers.delete(timerId);
        console.log(`Timer ${timerId} deleted`);
        
        // Send updated timer list to all clients
        const timerList = Array.from(timers.values()).map(timer => ({
          id: timer.id,
          name: timer.name,
          duration: timer.duration,
          connectedCount: timer.connectedDevices.size
        }));
        // console.log('Broadcasting updated timer list after deletion:', timerList);
        io.emit('timer-list', timerList);
      }
    // } else {
    //   console.log('Unauthorized delete-timer attempt from:', socket.id);
    // }
  });

  // Timer controls (controller only)
  socket.on('set-timer', (data) => {
    // console.log('Set timer request:', socket.id, 'data:', data);
    // if (authenticatedControllers.has(socket.id)) {
      ensureControllerConnected(socket, data.timerId);
      const timer = timers.get(data.timerId);
      if (timer) {
        timer.setDuration(data.duration);
      }
    // } else {
    //   console.log('Unauthorized set-timer attempt from:', socket.id);
    // }
  });

  socket.on('start-timer', (timerId) => {
    // console.log('Start timer request:', socket.id, 'timerId:', timerId);
    // console.log(controllerSocketId," --controllerSocketId")
    // console.log('Authenticated controllers:', Array.from(authenticatedControllers));
    // if (authenticatedControllers.has(socket.id)) {
      ensureControllerConnected(socket, timerId);
      const timer = timers.get(timerId);
      if (timer) {
        timer.start();
      }
    // } else {
    //   console.log('Unauthorized start-timer attempt from:', socket.id);
    // }
  });

  socket.on('pause-timer', (timerId) => {
    // console.log('Pause timer request:', socket.id, 'timerId:', timerId);
    // if (authenticatedControllers.has(socket.id)) {
      ensureControllerConnected(socket, timerId);
      const timer = timers.get(timerId);
      if (timer) {
        timer.pause();
      }
    // } else {
    //   console.log('Unauthorized pause-timer attempt from:', socket.id);
    // }
  });

  socket.on('reset-timer', (timerId) => {
    console.log('Reset timer request:', socket.id, 'timerId:', timerId);
    // if (authenticatedControllers.has(socket.id)) {
      ensureControllerConnected(socket, timerId);
      const timer = timers.get(timerId);
      if (timer) {
        timer.reset();
      }
    // } else {
    //   console.log('Unauthorized reset-timer attempt from:', socket.id);
    // }
  });

  socket.on('adjust-timer', (data) => {
    console.log('Adjust timer request:', socket.id, 'data:', data);
    // if (authenticatedControllers.has(socket.id)) {
      ensureControllerConnected(socket, data.timerId);
      const timer = timers.get(data.timerId);
      if (timer) {
        timer.adjustTime(data.seconds);
      }
    // } else {
    //   console.log('Unauthorized adjust-timer attempt from:', socket.id);
    // }
  });

  socket.on('update-message', (data) => {
    // console.log('Update message request:', socket.id, 'data:', data);
    // if (authenticatedControllers.has(socket.id)) {
      ensureControllerConnected(socket, data.timerId);
      const timer = timers.get(data.timerId);
      if (timer) {
        timer.updateMessage(data.message);
      }
    // } else {
    //   console.log('Unauthorized update-message attempt from:', socket.id);
    // }
  });

  socket.on('clear-message', (timerId) => {
    // console.log('Clear message request:', socket.id, 'timerId:', timerId);
    // if (authenticatedControllers.has(socket.id)) {
      ensureControllerConnected(socket, timerId);
      const timer = timers.get(timerId);
      if (timer) {
        timer.clearMessage();
      }
    // } else {
    //   console.log('Unauthorized clear-message attempt from:', socket.id);
    // }
  });

  socket.on('update-styling', (data) => {
    // console.log('Update styling request:', socket.id, 'data:', data);
    // if (authenticatedControllers.has(socket.id)) {
      ensureControllerConnected(socket, data.timerId);
      const timer = timers.get(data.timerId);
      if (timer) {
        console.log('Updating styling for timer:', data.timerId);
        console.log('Previous styling:', {
          backgroundColor: timer.backgroundColor,
          textColor: timer.textColor,
          fontSize: timer.fontSize
        });
        console.log('New styling:', data.styling);
        timer.updateStyling(data.styling);
        console.log('Styling updated successfully');
      } else {
        console.log('Timer not found for styling update:', data.timerId);
      }
    // } else {
    //   console.log('Unauthorized update-styling attempt from:', socket.id);
    // }
  });

  socket.on('toggle-flash', (data) => {
    console.log('Toggle flash request:', socket.id, 'data:', data);
    // if (authenticatedControllers.has(socket.id)) {
      ensureControllerConnected(socket, data.timerId);
      const timer = timers.get(data.timerId);
      if (timer) {
        timer.toggleFlash(data.isFlashing);
      }
    // } else {
    //   console.log('Unauthorized toggle-flash attempt from:', socket.id);
    // }
  });

  // Handle disconnection
  socket.on('disconnect', () => {
    // console.log('Client disconnected:', socket.id);
    
    // Remove from authenticated controllers if it was a controller
    // if (authenticatedControllers.has(socket.id)) {
      // authenticatedControllers.delete(socket.id);
      // console.log('Controller removed from authenticated list:', socket.id);
      
      // If this was the current controllerSocketId, clear it
      if (controllerSocketId === socket.id) {
        controllerSocketId = null;
        console.log('controllerSocketId cleared due to disconnect');
      }
    // }
    
    // Remove from timer
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