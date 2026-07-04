const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Раздаём статические файлы из папки public
app.use(express.static(path.join(__dirname, 'public')));

// Хранилище сообщений (в памяти сервера)
let messages = [];
const MAX_MESSAGES = 200;

// Хранилище подключённых пользователей
const clients = new Map(); // key: ws, value: { username, id }

// Генерация уникального ID
function generateId() {
    return Date.now() + '-' + Math.random().toString(36).substr(2, 9);
}

// Подсчёт онлайн пользователей
function getOnlineCount() {
    let count = 0;
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            count++;
        }
    });
    return count;
}

// Отправка сообщения всем клиентам
function broadcast(data, excludeClient = null) {
    wss.clients.forEach(client => {
        if (client !== excludeClient && client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify(data));
        }
    });
}

// Отправка истории новому пользователю
function sendHistory(client) {
    if (client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify({
            type: 'history',
            messages: messages
        }));
    }
}

// Отправка количества онлайн всем
function broadcastOnlineCount() {
    const count = getOnlineCount();
    broadcast({
        type: 'online_count',
        count: count
    });
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
    
    // Ограничиваем количество хранимых сообщений
    if (messages.length > MAX_MESSAGES) {
        messages = messages.slice(-MAX_MESSAGES);
    }
    
    // Рассылаем сообщение всем клиентам
    broadcast({
        type: 'new_message',
        message: message
    });
    
    return message;
}

// Обработка WebSocket соединений
wss.on('connection', (ws, req) => {
    const clientId = generateId();
    let username = 'Гость';
    const clientIp = req.socket.remoteAddress;
    
    console.log(`🔌 Новое подключение: ${clientId} (${clientIp})`);
    
    // Отправляем приветствие
    ws.send(JSON.stringify({
        type: 'connected',
        message: 'Добро пожаловать в Pанхол Мессенджер!',
        clientId: clientId
    }));
    
    // Отправляем историю сообщений
    sendHistory(ws);
    
    // Отправляем текущее количество онлайн
    ws.send(JSON.stringify({
        type: 'online_count',
        count: getOnlineCount()
    }));
    
    // Обработка сообщений от клиента
    ws.on('message', (data) => {
        try {
            const parsed = JSON.parse(data);
            
            switch (parsed.type) {
                case 'set_username':
                    const oldUsername = username;
                    username = parsed.username.substring(0, 30) || 'Гость';
                    
                    // Сохраняем информацию о клиенте
                    clients.set(ws, { username, id: clientId });
                    
                    // Системное сообщение о смене имени
                    if (oldUsername !== username && oldUsername !== 'Гость') {
                        addMessage('Система', `${oldUsername} сменил имя на ${username}`, true);
                    } else if (oldUsername === 'Гость' && username !== 'Гость') {
                        addMessage('Система', `${username} присоединился к чату`, true);
                    }
                    
                    console.log(`📝 Пользователь ${clientId} установил имя: ${username}`);
                    break;
                    
                case 'message':
                    if (parsed.text && parsed.text.trim()) {
                        addMessage(username, parsed.text.trim(), false);
                        console.log(`💬 ${username}: ${parsed.text.trim()}`);
                    }
                    break;
                    
                default:
                    console.log('Неизвестный тип сообщения:', parsed.type);
            }
        } catch (error) {
            console.error('Ошибка обработки сообщения:', error);
        }
    });
    
    // Обработка отключения
    ws.on('close', () => {
        console.log(`👋 Пользователь отключился: ${username} (${clientId})`);
        clients.delete(ws);
        
        // Системное сообщение о выходе (только если пользователь успел представиться)
        if (username !== 'Гость') {
            broadcast({
                type: 'new_message',
                message: {
                    id: generateId(),
                    username: 'Система',
                    text: `${username} покинул чат`,
                    timestamp: Date.now(),
                    isSystem: true
                }
            });
        }
        
        // Обновляем количество онлайн
        broadcastOnlineCount();
    });
    
    // Обновляем количество онлайн для всех
    broadcastOnlineCount();
});

// Запуск сервера
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`
    ═══════════════════════════════════════
    🚀 Pанхол Мессенджер запущен!
    📡 Сервер: http://localhost:${PORT}
    💬 WebSocket: ws://localhost:${PORT}
    ═══════════════════════════════════════
    
    💡 Для доступа с других устройств в локальной сети:
       http://[ВАШ_IP]:${PORT}
    
    💡 Чтобы узнать ваш IP, введите в терминале:
       • Windows: ipconfig
       • Mac/Linux: ifconfig
    `);
});