const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// Хранилище сообщений (в памяти сервера)
let messages = [];
const MAX_MESSAGES = 200;

// Хранилище подключённых пользователей
const clients = new Map();

// Генерация уникального ID
function generateId() {
    return Date.now() + '-' + Math.random().toString(36).substr(2, 9);
}

// --- ГОЛОСОВОЙ ЧАТ (WebRTC) ---
const rooms = {};

// Подсчёт онлайн пользователей
function getOnlineCount() {
    let count = 0;
    // В Socket.IO используем io.sockets.sockets
    io.sockets.sockets.forEach(() => count++);
    return count;
}

// Отправка сообщения всем клиентам
function broadcast(data, excludeClient = null) {
    io.emit('new_message', data);
}

// Отправка истории новому пользователю
function sendHistory(client) {
    client.emit('history', { messages });
}

// Отправка количества онлайн всем
function broadcastOnlineCount() {
    const count = getOnlineCount();
    io.emit('online_count', { count });
}

// Добавление нового сообщения в историю
function addMessage(username, text, isSystem = false) {
    const message = {
        id: generateId(),
        username: username,
        text: text,
        timestamp: Date.now(),
        isSystem: isSystem
    };
    messages.push(message);
    if (messages.length > MAX_MESSAGES) {
        messages = messages.slice(-MAX_MESSAGES);
    }
    broadcast({ type: 'new_message', message });
    return message;
}

// Обработка Socket.IO соединений
io.on('connection', (socket) => {
    console.log('New client connected:', socket.id);

    // Отправляем историю
    sendHistory(socket);

    // --- ГОЛОСОВОЙ ЧАТ ---
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

    // --- Обычные сообщения ---
    socket.on('send_message', (data) => {
        const { username, text } = data;
        if (text && text.trim()) {
            addMessage(username || 'Аноним', text.trim(), false);
        }
    });

    socket.on('disconnect', () => {
        console.log('Client disconnected:', socket.id);
        // Удаляем из всех голосовых комнат
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
