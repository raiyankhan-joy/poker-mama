'use strict';

const crypto = require('crypto');
const EventEmitter = require('events');

const WS_MAGIC_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

class WSClient extends EventEmitter {
  constructor(socket, id) {
    super();
    this.socket = socket;
    this.id = id;
    this.alive = true;
    this.closed = false;
    this._buffer = Buffer.alloc(0);
    this._fragments = [];
    this._fragmentLen = 0;

    socket.on('data', (chunk) => this._onData(chunk));
    socket.on('end', () => this._handleClose());
    socket.on('close', () => this._handleClose());
    socket.on('error', () => this._handleClose());
  }

  sendJSON(obj) {
    if (this.closed || this.socket.destroyed) return;
    const text = JSON.stringify(obj);
    this._sendFrame(0x1, Buffer.from(text, 'utf8'));
  }

  ping() {
    if (this.closed || this.socket.destroyed) return;
    this._sendFrame(0x9, Buffer.alloc(0));
  }

  close() {
    if (this.closed) return;
    try {
      this._sendFrame(0x8, Buffer.alloc(0));
    } catch (_) {
      // ignore socket teardown error
    }
    try {
      this.socket.destroy();
    } catch (_) {
      // ignore socket teardown error
    }
    this._handleClose();
  }

  _sendFrame(opcode, payload) {
    if (this.closed || this.socket.destroyed) return;
    const len = payload.length;
    let header;
    if (len < 126) {
      header = Buffer.alloc(2);
      header[0] = 0x80 | opcode;
      header[1] = len;
    } else if (len < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x80 | opcode;
      header[1] = 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x80 | opcode;
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(len), 2);
    }
    try {
      this.socket.write(Buffer.concat([header, payload]));
    } catch (_) {
      this._handleClose();
    }
  }

  _onData(chunk) {
    this.alive = true;
    const MAX_FRAME_BYTES = 65536; // 64 KB DoS protection
    this._buffer = Buffer.concat([this._buffer, chunk]);
    if (this._buffer.length > MAX_FRAME_BYTES * 2) {
      this.close();
      return;
    }

    while (this._buffer.length >= 2) {
      const firstByte = this._buffer[0];
      const secondByte = this._buffer[1];
      const isFin = (firstByte & 0x80) !== 0;
      const opcode = firstByte & 0x0f;
      const isMasked = (secondByte & 0x80) !== 0;
      let payloadLen = secondByte & 0x7f;
      let offset = 2;

      if (payloadLen === 126) {
        if (this._buffer.length < 4) return;
        payloadLen = this._buffer.readUInt16BE(2);
        offset = 4;
      } else if (payloadLen === 127) {
        if (this._buffer.length < 10) return;
        const bigLen = this._buffer.readBigUInt64BE(2);
        if (bigLen > BigInt(MAX_FRAME_BYTES)) {
          this.close();
          return;
        }
        payloadLen = Number(bigLen);
        offset = 10;
      }

      if (payloadLen > MAX_FRAME_BYTES) {
        this.close();
        return;
      }

      const maskLen = isMasked ? 4 : 0;
      const totalFrameLen = offset + maskLen + payloadLen;
      if (this._buffer.length < totalFrameLen) return;

      let payload = Buffer.alloc(payloadLen);
      if (isMasked) {
        const mask = this._buffer.subarray(offset, offset + 4);
        const raw = this._buffer.subarray(offset + 4, totalFrameLen);
        for (let i = 0; i < payloadLen; i++) {
          payload[i] = raw[i] ^ mask[i % 4];
        }
      } else {
        payload = this._buffer.subarray(offset, totalFrameLen);
      }

      this._buffer = this._buffer.subarray(totalFrameLen);

      if (opcode === 0x8) {
        this._handleClose();
        return;
      } else if (opcode === 0x9) {
        // Ping -> reply with Pong
        this._sendFrame(0xA, payload);
      } else if (opcode === 0xA) {
        this.alive = true;
      } else if (opcode === 0x1 || opcode === 0x0) {
        if (opcode === 0x1) {
          this._fragments = [payload];
          this._fragmentLen = payload.length;
        } else {
          this._fragments.push(payload);
          this._fragmentLen += payload.length;
          if (this._fragmentLen > MAX_FRAME_BYTES) {
            this.close();
            return;
          }
        }
        if (isFin) {
          const fullPayload = this._fragments.length === 1
            ? this._fragments[0]
            : Buffer.concat(this._fragments);
          this._fragments = [];
          this._fragmentLen = 0;
          try {
            const parsed = JSON.parse(fullPayload.toString('utf8'));
            this.emit('message', parsed);
          } catch (_) {
            // Ignore malformed JSON frames
          }
        }
      }
    }
  }

  _handleClose() {
    if (this.closed) return;
    this.closed = true;
    this.emit('close');
  }
}

class WSServer extends EventEmitter {
  constructor(httpServer) {
    super();
    this.clients = new Map();

    httpServer.on('upgrade', (req, socket) => {
      const key = req.headers['sec-websocket-key'];
      if (!key) {
        socket.destroy();
        return;
      }

      const acceptKey = crypto
        .createHash('sha1')
        .update(key + WS_MAGIC_GUID)
        .digest('base64');

      const headers = [
        'HTTP/1.1 101 Switching Protocols',
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Accept: ${acceptKey}`,
        '',
        ''
      ];
      socket.setNoDelay(true);
      socket.write(headers.join('\r\n'));

      const clientId = crypto.randomBytes(8).toString('hex');
      const client = new WSClient(socket, clientId);
      this.clients.set(clientId, client);

      client.on('close', () => {
        this.clients.delete(clientId);
      });

      this.emit('connection', client);
    });

    // Heartbeat to detect stale sockets
    this._interval = setInterval(() => {
      for (const [id, client] of this.clients.entries()) {
        if (client.closed || client.socket.destroyed) {
          this.clients.delete(id);
          continue;
        }
        if (!client.alive) {
          client.close();
          this.clients.delete(id);
          continue;
        }
        client.alive = false;
        client.ping();
      }
    }, 20000);
  }

  close() {
    clearInterval(this._interval);
    for (const client of this.clients.values()) {
      client.close();
    }
  }
}

module.exports = { WSServer, WSClient };
