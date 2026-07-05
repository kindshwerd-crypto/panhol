const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.static(path.join(__dirname, 'public')));

// --- Хранилища ---
const users = new Map(); // username -> { password, displayName, socket, online, channels, groups }
const channels = new Map(); // channelName -> { messages: [], members: Set }
const groups = new Map(); // groupId -> { name, creator, members: Set, messages: [] }
const directMessages = new Map(); // `user1:user2` -> []

// --- Вспомогательные функции ---
function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).substr(2, 5);
}

function getUser(username) {
  return users.get(username);
}

function isAuthenticated(ws) {
  for (let [username, user] of users) {
    if (user.socket === ws) return username;
  }
  return null;
}

function broadcastToChannel(channelName, message) {
  const channel = channels.get(channelName);
  if (!channel) return;
  channel.members.forEach(username => {
    const user = users.get(username);
    if (user && user.socket && user.socket.readyState === WebSocket.OPEN) {
      user.socket.send(JSON.stringify({ type: 'channel_message', channel: channelName, message }));
    }
  });
}

function broadcastToGroup(groupId, message) {
  const group = groups.get(groupId);
  if (!group) return;
  group.members.forEach(username => {
    const user = users.get(username);
    if (user && user.socket && user.socket.readyState === WebSocket.OPEN) {
      user.socket.send(JSON.stringify({ type: 'group_message', groupId, message }));
    }
  });
}

function sendDirectMessage(from, to, text) {
  const sender = users.get(from);
  const receiver = users.get(to);
  if (!sender || !receiver) return false;
  const key = [from, to].sort().join(':');
  if (!directMessages.has(key)) directMessages.set(key, []);
  const msg = { id: generateId(), from, to, text, timestamp: Date.now() };
  directMessages.get(key).push(msg);
  // Отправить получателю, если онлайн
  if (receiver.socket && receiver.socket.readyState === WebSocket.OPEN) {
    receiver.socket.send(JSON.stringify({ type: 'direct_message', from, message: msg }));
  }
  // Отправить отправителю для отображения
  if (sender.socket && sender.socket.readyState === WebSocket.OPEN) {
    sender.socket.send(JSON.stringify({ type: 'direct_message_echo', to, message: msg }));
  }
  return true;
}

// --- WebSocket ---
wss.on('connection', (ws) => {
  let currentUser = null;

  ws.on('message', (data) => {
    try {
      const parsed = JSON.parse(data);
      const { type, payload } = parsed;

      switch (type) {
        case 'login': {
          const { username, password } = payload;
          const user = users.get(username);
          if (user && user.password === password) {
            user.socket = ws;
            user.online = true;
            currentUser = username;
            ws.send(JSON.stringify({ type: 'auth_success', username }));
            // Отправить списки каналов, групп, настройки
            ws.send(JSON.stringify({
              type: 'initial_data',
              channels: Array.from(channels.keys()),
              groups: Array.from(groups.values()).map(g => ({ id: g.id, name: g.name, members: [...g.members] })),
              directChats: [...directMessages.keys()].filter(k => k.includes(username))
            }));
            // Уведомить всех о входе
            broadcastToChannel('общий', { username, text: `${username} вошёл в чат`, isSystem: true });
          } else {
            ws.send(JSON.stringify({ type: 'auth_fail', message: 'Неверный логин или пароль' }));
          }
          break;
        }
        case 'register': {
          const { username, password, displayName } = payload;
          if (users.has(username)) {
            ws.send(JSON.stringify({ type: 'auth_fail', message: 'Пользователь уже существует' }));
          } else {
            users.set(username, { password, displayName: displayName || username, socket: ws, online: true, channels: new Set(['общий']), groups: new Set() });
            currentUser = username;
            ws.send(JSON.stringify({ type: 'auth_success', username }));
            // Создать канал "общий", если нет
            if (!channels.has('общий')) {
              channels.set('общий', { messages: [], members: new Set() });
            }
            channels.get('общий').members.add(username);
            // Уведомить всех
            broadcastToChannel('общий', { username: 'Система', text: `${username} зарегистрировался и присоединился`, isSystem: true });
          }
          break;
        }
        case 'join_channel': {
          const { channel } = payload;
          if (!channels.has(channel)) {
            channels.set(channel, { messages: [], members: new Set() });
          }
          channels.get(channel).members.add(currentUser);
          ws.send(JSON.stringify({ type: 'channel_joined', channel }));
          break;
        }
        case 'send_channel': {
          const { channel, text } = payload;
          if (!channels.has(channel)) return;
          const msg = { id: generateId(), username: currentUser, text, timestamp: Date.now() };
          channels.get(channel).messages.push(msg);
          broadcastToChannel(channel, msg);
          break;
        }
        case 'create_group': {
          const { groupName } = payload;
          const id = generateId();
          groups.set(id, { id, name: groupName, creator: currentUser, members: new Set([currentUser]), messages: [] });
          users.get(currentUser).groups.add(id);
          ws.send(JSON.stringify({ type: 'group_created', groupId: id, groupName }));
          break;
        }
        case 'invite_to_group': {
          const { groupId, targetUser } = payload;
          const group = groups.get(groupId);
          if (!group || !group.members.has(currentUser)) return;
          if (!users.has(targetUser)) return;
          group.members.add(targetUser);
          users.get(targetUser).groups.add(groupId);
          // Уведомить приглашённого
          const target = users.get(targetUser);
          if (target.socket && target.socket.readyState === WebSocket.OPEN) {
            target.socket.send(JSON.stringify({ type: 'group_invite', groupId, groupName: group.name, from: currentUser }));
          }
          break;
        }
        case 'send_group': {
          const { groupId, text } = payload;
          const group = groups.get(groupId);
          if (!group || !group.members.has(currentUser)) return;
          const msg = { id: generateId(), username: currentUser, text, timestamp: Date.now() };
          group.messages.push(msg);
          broadcastToGroup(groupId, msg);
          break;
        }
        case 'send_direct': {
          const { to, text } = payload;
          sendDirectMessage(currentUser, to, text);
          break;
        }
        case 'set_display_name': {
          const { displayName } = payload;
          if (users.has(currentUser)) {
            users.get(currentUser).displayName = displayName;
            ws.send(JSON.stringify({ type: 'settings_updated', displayName }));
          }
          break;
        }
        default:
          console.log('Неизвестный тип:', type);
      }
    } catch (e) {
      console.error('Ошибка обработки:', e);
    }
  });

  ws.on('close', () => {
    if (currentUser) {
      const user = users.get(currentUser);
      if (user) {
        user.online = false;
        user.socket = null;
        broadcastToChannel('общий', { username: 'Система', text: `${currentUser} покинул чат`, isSystem: true });
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 Pанхол Мессенджер запущен на http://localhost:${PORT}`);
});
