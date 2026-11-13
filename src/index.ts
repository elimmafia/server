import { createServer } from 'node:http';
import { randomInt } from 'node:crypto';
import { Server, Socket } from 'socket.io';
import { GameError, Room } from './game.js';
import type { Settings } from './types.js';

const PORT = Number(process.env.PORT ?? 4000);
// 예: CLIENT_ORIGIN=https://my-mafia.vercel.app,http://localhost:5173
const ORIGINS = (process.env.CLIENT_ORIGIN ?? 'http://localhost:5173')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const httpServer = createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, rooms: rooms.size }));
    return;
  }
  res.writeHead(404);
  res.end();
});

const io = new Server(httpServer, {
  cors: { origin: ORIGINS.includes('*') ? true : ORIGINS },
  maxHttpBufferSize: 1e4,
});

const rooms = new Map<string, Room>();
// socket.id -> 참가 정보
const sessions = new Map<string, { code: string; token: string }>();

function broadcast(room: Room) {
  for (const [socketId, token] of room.socketIds()) {
    io.to(socketId).emit('state', room.viewFor(token));
  }
}

function newCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  for (;;) {
    let c = '';
    for (let i = 0; i < 4; i++) c += chars[randomInt(chars.length)];
    if (!rooms.has(c)) return c;
  }
}

type Ack = (res: { ok: boolean; error?: string; code?: string }) => void;

function isToken(t: unknown): t is string {
  return typeof t === 'string' && t.length >= 16 && t.length <= 64;
}

io.on('connection', (socket: Socket) => {
  /** 현재 소켓이 속한 방과 토큰을 가져와 핸들러 실행, 에러는 ack 로 반환 */
  const handle =
    <A extends unknown[]>(fn: (room: Room, token: string, ...args: A) => void) =>
    (...raw: unknown[]) => {
      const maybeAck = raw[raw.length - 1];
      const ack: Ack = typeof maybeAck === 'function' ? (maybeAck as Ack) : () => {};
      const args = (typeof maybeAck === 'function' ? raw.slice(0, -1) : raw) as A;
      const s = sessions.get(socket.id);
      const room = s && rooms.get(s.code);
      if (!s || !room) return ack({ ok: false, error: '방에 접속되어 있지 않습니다.' });
      try {
        fn(room, s.token, ...args);
        ack({ ok: true });
      } catch (e) {
        if (e instanceof GameError) ack({ ok: false, error: e.message });
        else {
          console.error(e);
          ack({ ok: false, error: '서버 오류가 발생했습니다.' });
        }
      }
    };

  function attach(room: Room, token: string, name: string, ack: Ack) {
    try {
      const prev = sessions.get(socket.id);
      if (prev && (prev.code !== room.code || prev.token !== token)) {
        rooms.get(prev.code)?.disconnect(socket.id);
        socket.leave(prev.code);
      }
      room.join(token, name, socket.id);
      sessions.set(socket.id, { code: room.code, token });
      socket.join(room.code);
      ack({ ok: true, code: room.code });
    } catch (e) {
      ack({ ok: false, error: e instanceof GameError ? e.message : '서버 오류가 발생했습니다.' });
    }
  }

  socket.on('room:create', (p: { name?: string; token?: string }, ack: Ack) => {
    if (typeof ack !== 'function') return;
    if (!isToken(p?.token)) return ack({ ok: false, error: '잘못된 요청입니다.' });
    if (rooms.size > 500) return ack({ ok: false, error: '서버에 방이 너무 많습니다.' });
    const room = new Room(newCode(), broadcast);
    rooms.set(room.code, room);
    attach(room, p.token, String(p.name ?? ''), (res) => {
      if (!res.ok) {
        room.destroy();
        rooms.delete(room.code);
      }
      ack(res);
    });
  });

  socket.on('room:join', (p: { code?: string; name?: string; token?: string }, ack: Ack) => {
    if (typeof ack !== 'function') return;
    if (!isToken(p?.token)) return ack({ ok: false, error: '잘못된 요청입니다.' });
    const room = rooms.get(String(p.code ?? '').toUpperCase().trim());
    if (!room) return ack({ ok: false, error: '존재하지 않는 방 코드입니다.' });
    attach(room, p.token, String(p.name ?? ''), ack);
  });

  socket.on(
    'room:leave',
    handle((room, token) => {
      room.leave(token);
      sessions.delete(socket.id);
      socket.leave(room.code);
    }),
  );

  socket.on(
    'room:kick',
    handle((room, token, targetId: string) => {
      const kickedSocket = room.kick(token, String(targetId));
      if (kickedSocket) {
        sessions.delete(kickedSocket);
        io.to(kickedSocket).emit('kicked');
      }
    }),
  );

  socket.on('room:settings', handle((room, token, s: Partial<Settings>) => room.updateSettings(token, s ?? {})));
  socket.on('game:start', handle((room, token) => room.start(token)));
  socket.on('game:lobby', handle((room, token) => room.backToLobby(token)));
  socket.on('host:next', handle((room, token) => room.hostNext(token)));
  socket.on('night:pick', handle((room, token, targetId: string) => room.nightPick(token, String(targetId))));
  socket.on('night:next', handle((room, token) => room.nightNext(token)));
  socket.on('night:skip', handle((room, token) => room.hostSkipNightStep(token)));
  socket.on(
    'vote:cast',
    handle((room, token, targetId: string | null) => room.vote(token, targetId == null ? null : String(targetId))),
  );
  socket.on('final:cast', handle((room, token, agree: boolean) => room.finalVote(token, agree === true)));

  socket.on('disconnect', () => {
    const s = sessions.get(socket.id);
    sessions.delete(socket.id);
    if (s) rooms.get(s.code)?.disconnect(socket.id);
  });
});

// 아무도 접속하지 않은 방은 15분 후 정리
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (!room.hasConnected() && now - room.lastActive > 15 * 60 * 1000) {
      room.destroy();
      rooms.delete(code);
    }
  }
}, 60 * 1000);

httpServer.listen(PORT, () => {
  console.log(`Mafia server listening on :${PORT} (allowed origins: ${ORIGINS.join(', ')})`);
});
