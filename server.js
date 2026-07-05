const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// Хранилища
const users = new Map();          // socketId -> { userId, name }
const userIdToSocket = new Map(); // userId -> socketId
const contacts = new Map();       // userId -> Set of userIds
const chats = new Map();          // chatId -> { type, name, participants, messages, avatar }
const chatParticipants = new Map(); // userId -> Set of chatIds

function generateId() {
    return Math.random().toString(36).substring(2, 10) + Date.now().toString(36);
}

function getOrCreatePrivateChat(user1, user2) {
    const existing = Array.from(chats.values()).find(chat =>
        chat.type === 'private' &&
        chat.participants.includes(user1) &&
        chat.participants.includes(user2)
    );
    if (existing) return existing.id;

    const chatId = generateId();
    const chat = {
        id: chatId,
        type: 'private',
        name: `Чат с ${user2.slice(0,6)}...`,
        participants: [user1, user2],
        messages: [],
        avatar: '👤'
    };
    chats.set(chatId, chat);
    [user1, user2].forEach(uid => {
        if (!chatParticipants.has(uid)) chatParticipants.set(uid, new Set());
        chatParticipants.get(uid).add(chatId);
    });
    return chatId;
}

function createGroupChat(name, participants, creatorId) {
    const chatId = generateId();
    const chat = {
        id: chatId,
        type: 'group',
        name: name || 'Новая группа',
        participants: [creatorId, ...participants.filter(p => p !== creatorId)],
        messages: [],
        avatar: '👥'
    };
    chats.set(chatId, chat);
    chat.participants.forEach(uid => {
        if (!chatParticipants.has(uid)) chatParticipants.set(uid, new Set());
        chatParticipants.get(uid).add(chatId);
    });
    return chatId;
}

function addMessage(chatId, senderId, text, type = 'text') {
    const chat = chats.get(chatId);
    if (!chat) return null;
    const message = {
        id: generateId(),
        senderId,
        text,
        type,
        timestamp: Date.now()
    };
    chat.messages.push(message);
    // Отправляем всем участникам, включая отправителя (для эха)
    chat.participants.forEach(uid => {
        const socketId = userIdToSocket.get(uid);
        if (socketId) {
            io.to(socketId).emit('new_message', { chatId, message });
        }
    });
    return message;
}

function sendUserChats(socketId, userId) {
    const userChatIds = chatParticipants.get(userId) || new Set();
    const userChats = Array.from(userChatIds).map(id => {
        const chat = chats.get(id);
        return {
            id: chat.id,
            type: chat.type,
            name: chat.name,
            avatar: chat.avatar,
            lastMessage: chat.messages.length ? chat.messages[chat.messages.length-1] : null
        };
    });
    io.to(socketId).emit('chats_list', userChats);
}

function sendUserContacts(socketId, userId) {
    const userContacts = contacts.get(userId) || new Set();
    const contactsList = Array.from(userContacts).map(contactId => {
        const contactSocket = userIdToSocket.get(contactId);
        return {
            id: contactId,
            name: contactId.slice(0,8),
            avatar: '👤',
            online: !!contactSocket
        };
    });
    io.to(socketId).emit('contacts_list', contactsList);
}

io.on('connection', (socket) => {
    console.log('New client connected:', socket.id);
    let userId = null;

    socket.on('register', (data, callback) => {
        let uid = data.userId;
        if (!uid) uid = generateId();
        userId = uid;
        users.set(socket.id, { userId, name: userId.slice(0,8) });
        userIdToSocket.set(userId, socket.id);
        if (!contacts.has(userId)) contacts.set(userId, new Set());
        callback({ userId });
        sendUserChats(socket.id, userId);
        sendUserContacts(socket.id, userId);
        // Уведомляем контакты об онлайн
        const userContacts = contacts.get(userId) || new Set();
        userContacts.forEach(contactId => {
            const contactSocketId = userIdToSocket.get(contactId);
            if (contactSocketId) {
                io.to(contactSocketId).emit('contact_status', { userId, online: true });
            }
        });
        console.log(`User ${userId} registered`);
    });

    socket.on('add_contact', (contactId, callback) => {
        if (!userId) return;
        if (contactId === userId) {
            callback({ success: false, error: 'Нельзя добавить себя' });
            return;
        }
        const userContacts = contacts.get(userId);
        if (userContacts.has(contactId)) {
            callback({ success: false, error: 'Контакт уже добавлен' });
            return;
        }
        userContacts.add(contactId);
        // Автоматически создаём чат
        getOrCreatePrivateChat(userId, contactId);
        sendUserContacts(socket.id, userId);
        const contactSocketId = userIdToSocket.get(contactId);
        if (contactSocketId) {
            sendUserContacts(contactSocketId, contactId);
            io.to(contactSocketId).emit('contact_added', { contactId: userId });
        }
        // Обновляем списки чатов для обоих
        sendUserChats(socket.id, userId);
        if (contactSocketId) sendUserChats(contactSocketId, contactId);
        callback({ success: true });
        console.log(`Contact ${contactId} added to ${userId}`);
    });

    socket.on('create_group', (data, callback) => {
        if (!userId) return;
        const { name, participants } = data;
        const chatId = createGroupChat(name, participants, userId);
        const chat = chats.get(chatId);
        chat.participants.forEach(uid => {
            const sid = userIdToSocket.get(uid);
            if (sid) sendUserChats(sid, uid);
        });
        callback({ success: true, chatId });
        console.log(`Group ${name} created by ${userId}`);
    });

    socket.on('send_message', (data, callback) => {
        if (!userId) {
            callback({ success: false, error: 'Не авторизован' });
            return;
        }
        const { chatId, text, type } = data;
        const chat = chats.get(chatId);
        if (!chat || !chat.participants.includes(userId)) {
            callback({ success: false, error: 'Чат не найден или нет доступа' });
            return;
        }
        const message = addMessage(chatId, userId, text, type || 'text');
        callback({ success: true, message });
        console.log(`Message from ${userId} in chat ${chatId}: ${text}`);
    });

    socket.on('get_chat_history', (chatId, callback) => {
        if (!userId) return;
        const chat = chats.get(chatId);
        if (!chat || !chat.participants.includes(userId)) {
            callback({ success: false, error: 'Нет доступа' });
            return;
        }
        callback({ success: true, messages: chat.messages });
    });

    socket.on('call_user', (data) => {
        const { targetUserId, isVideo } = data;
        const targetSocket = userIdToSocket.get(targetUserId);
        if (targetSocket) {
            io.to(targetSocket).emit('incoming_call', {
                from: userId,
                isVideo: isVideo
            });
            console.log(`Call from ${userId} to ${targetUserId}`);
        } else {
            console.log(`Call failed: ${targetUserId} offline`);
        }
    });

    socket.on('disconnect', () => {
        console.log('Client disconnected:', socket.id);
        const user = users.get(socket.id);
        if (user) {
            const uid = user.userId;
            userIdToSocket.delete(uid);
            users.delete(socket.id);
            const userContacts = contacts.get(uid) || new Set();
            userContacts.forEach(contactId => {
                const contactSocketId = userIdToSocket.get(contactId);
                if (contactSocketId) {
                    io.to(contactSocketId).emit('contact_status', { userId: uid, online: false });
                }
            });
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
});
