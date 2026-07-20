const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// Хранилище сообщений для каждой комнаты
const roomMessages = {
    'global': [] // Глобальный чат
};
const MAX_MESSAGES = 200;
const clients = new Map();

// --- Голосовой чат (WebRTC) ---
const rooms = {};

function generateId() {
    return Date.now() + '-' + Math.random().toString(36).substr(2, 9);
}

function getOnlineCount() {
    let count = 0;
    io.sockets.sockets.forEach(() => count++);
    return count;
}

function broadcastOnlineCount() {
    io.emit('online_count', { count: getOnlineCount() });
}

// Функция для получения или создания хранилища сообщений для комнаты
function getRoomMessages(roomId) {
    if (!roomMessages[roomId]) {
        roomMessages[roomId] = [];
    }
    return roomMessages[roomId];
}

// Добавление сообщения в комнату
function addMessageToRoom(roomId, username, text, isSystem = false) {
    const messages = getRoomMessages(roomId);
    const message = {
        id: generateId(),
        username: username,
        text: text,
        timestamp: Date.now(),
        isSystem: isSystem
    };
    messages.push(message);
    if (messages.length > MAX_MESSAGES) {
        messages.splice(0, messages.length - MAX_MESSAGES);
    }
    // Отправляем сообщение только в эту комнату
    io.to(roomId).emit('new_message', { roomId, message });
    return message;
}

io.on('connection', (socket) => {
    console.log('New client connected:', socket.id);
    let currentRoom = 'global'; // По умолчанию в глобальном чате

    // Отправляем историю глобального чата
    socket.emit('history', { roomId: 'global', messages: roomMessages['global'] || [] });

    // Подписка на комнату
    socket.on('join_room', ({ roomId }) => {
        // Выходим из предыдущей комнаты
        if (currentRoom) {
            socket.leave(currentRoom);
        }
        // Входим в новую комнату
        currentRoom = roomId;
        socket.join(roomId);
        // Отправляем историю этой комнаты
        const messages = getRoomMessages(roomId);
        socket.emit('history', { roomId, messages });
        console.log(`User ${socket.id} joined room: ${roomId}`);
    });

    // Отправка сообщения
    socket.on('send_message', ({ roomId, username, text }) => {
        if (text && text.trim()) {
            addMessageToRoom(roomId, username || 'Аноним', text.trim(), false);
        }
    });

    // --- ГОЛОСОВОЙ ЧАТ (без изменений) ---
    socket.on('join-voice-room', (roomId) => {
        if (!rooms[roomId]) rooms[roomId] = [];
        if (!rooms[roomId].includes(socket.id)) {
            rooms[roomId].push(socket.id);
        }
        socket.join(roomId);
        io.to(roomId).emit('user-joined-voice', socket.id);
        console.log(`User ${socket.id} joined voice room: ${roomId}`);
    });

    socket.on('leave-voice-room', (roomId) => {
        if (rooms[roomId]) {
            rooms[roomId] = rooms[roomId].filter(id => id !== socket.id);
            if (rooms[roomId].length === 0) delete rooms[roomId];
        }
        socket.leave(roomId);
        io.to(roomId).emit('user-left-voice', socket.id);
        console.log(`User ${socket.id} left voice room: ${roomId}`);
    });

    socket.on('voice-signal', ({ to, signal }) => {
        io.to(to).emit('voice-signal', { from: socket.id, signal });
    });

    socket.on('disconnect', () => {
        console.log('Client disconnected:', socket.id);
        for (const roomId in rooms) {
            rooms[roomId] = rooms[roomId].filter(id => id !== socket.id);
            if (rooms[roomId].length === 0) delete rooms[roomId];
        }
        broadcastOnlineCount();
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
});
